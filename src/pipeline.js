// Pipelines: plan -> execute -> review, and on "changes_requested" (or a failed verify) resume the
// executor with the findings and review again, up to max_fix_rounds. Always stops before merge:
// merging stays a developer decision.
//
// Kraken drives the steps (pipeline-driver.js, a detached process like the worker), so agents
// still never delegate to agents. A question from any step pauses the pipeline as "waiting"; the
// head answers that run as usual and the pipeline follows the answered run.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId, nowIso, getRun, insertPipeline, getPipeline, updatePipeline, resumedBy, IN_PROGRESS,
  pipelineMessagesSince, pipelineMessagesSinceAll, lastPipelineMessageId, pipelineRuns } from './store.js';
import { startNode } from './scheduler.js';
import { cancelRun, resumeRun } from './control.js';
import { mergeRun, approvalMode } from './branches.js';
import { startRun, describe, runLabel, renderFeed, STOP_NEXT } from './runs.js';

export const isPipelineId = (id) => typeof id === 'string' && id.startsWith('pipe_');

export function startPipeline({ task, cwd, session = 'default', verify, max_fix_rounds = 1, context_runs = [], overrides = {} }) {
  const dir = resolve(cwd ?? process.cwd());
  if (!existsSync(dir)) throw new Error(`cwd does not exist: ${dir}`);
  try { execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); }
  catch { throw new Error(`${dir} is not a git repo; a pipeline's execute step needs a worktree`); }
  for (const cid of context_runs) {
    const r = getRun(cid);
    if (!r || r.status !== 'done' || !r.result) throw new Error(`context run ${cid} must exist and be done with a result`);
  }
  const id = newId('pipe');
  insertPipeline({ id, session, task, cwd: dir, options: { verify, max_fix_rounds, context_runs, overrides } });
  updatePipeline(id, { pid: startNode('pipeline-driver.js', id) });
  return { pipeline_id: id, status: 'running', stage: 'plan',
    next: `call status with run_id "${id}" and wait_seconds 50 and since 0; the pipeline stops before merge` };
}

export function cancelPipeline(id) {
  const p = getPipeline(id);
  if (!p) throw new Error(`no pipeline ${id}`);
  if (!['running', 'waiting'].includes(p.status)) return { pipeline_id: id, status: p.status, changed: false };
  updatePipeline(id, { cancel_requested: 1 });
  // Stop the current step now; the driver records the pipeline as cancelled.
  const cur = p.current_run && getRun(p.current_run);
  if (cur && IN_PROGRESS.includes(cur.status)) cancelRun(cur.id);
  return { pipeline_id: id, status: 'cancelling', changed: true };
}

// What a pipeline is doing right now. Between an answer and the driver's next tick the stored
// status is still "waiting", but the run has been answered: report it as running.
export function pipelineStatus(p) {
  if (p.status !== 'waiting') return p.status;
  return getRun(p.current_run)?.status === 'waiting' ? 'waiting' : 'running';
}

// Stage names per run: plan, execute, review, "fix N" (resumed execute runs), "re-review" (later reviews).
function stageNames(pid) {
  const names = new Map();
  let reviews = 0, fixes = 0;
  for (const r of pipelineRuns(pid)) {
    let answering = false;
    try { answering = !!JSON.parse(r.config ?? '{}').answering; } catch { /* unreadable config */ }
    if (answering && names.has(r.resumed_from)) names.set(r.id, names.get(r.resumed_from)); // just an answer: same stage
    else if (r.tentacle === 'review') names.set(r.id, reviews++ ? 're-review' : 'review');
    else if (r.tentacle === 'execute') names.set(r.id, r.resumed_from ? `fix ${++fixes}` : 'execute');
    else names.set(r.id, r.tentacle);
  }
  return names;
}

// Feed lines for every run of a pipeline, one cursor for all of them.
export function pipelineFeed(p, since = 0, all = false) {
  const rows = all ? pipelineMessagesSinceAll(p.id, since) : pipelineMessagesSince(p.id, since, 200);
  const names = stageNames(p.id), runs = new Map();
  const labelOf = (rid) => {
    if (!runs.has(rid)) { const run = getRun(rid); runs.set(rid, run ? runLabel(run, names.get(rid)) : 'run'); }
    return runs.get(rid);
  };
  const showId = p.current_run ?? p.exec_run ?? p.plan_run ?? rows.at(-1)?.run_id ?? p.id;
  return { feed: renderFeed(rows, labelOf, showId),
    cursor: rows.length ? rows.at(-1).id : Math.max(since, lastPipelineMessageId(p.id)) };
}

export function describePipeline(p, full = false, live) {
  const opts = JSON.parse(p.options);
  const cur = p.current_run ? getRun(p.current_run) : null;
  const status = pipelineStatus(p);
  const waiting = status === 'waiting';
  return {
    id: p.id, kind: 'pipeline', status, stage: p.stage, task: p.task.slice(0, 200),
    fix_rounds: `${p.fix_rounds} of ${opts.max_fix_rounds}`,
    runs: { plan: p.plan_run ?? undefined, execute: p.exec_run ?? undefined, review: p.review_run ?? undefined },
    current: cur ? describeBrief(cur, full) : undefined,
    question: waiting ? cur.question : undefined,
    result: p.result ? JSON.parse(p.result) : undefined,
    error: p.error ?? undefined,
    ...live,
    cursor: live?.cursor ?? lastPipelineMessageId(p.id),
    next: waiting ? `ask the developer, then resume("${cur.id}", their reply); the pipeline continues by itself`
      : p.status === 'failed'
        ? STOP_NEXT
        : p.status === 'done' && p.exec_run && !getRun(p.exec_run)?.outcome
          ? `show merge("${p.exec_run}") to the developer; merge only after they approve`
          : undefined,
  };
}

function describeBrief(run, full) {
  const d = describe(run, full);
  return { id: d.id, tentacle: d.tentacle, status: d.status, verdict: d.verdict, error: d.error, stopped: d.stopped,
    recent: d.recent_messages.slice(-2).map((m) => m.body.slice(0, 160)), cost_usd: d.metrics.cost_usd };
}

// ---- driver: one step of the state machine; pipeline-driver.js calls it every second ----

const FINAL = ['done', 'failed', 'cancelled'];

export function tick(id) {
  const p = getPipeline(id);
  if (!p || FINAL.includes(p.status)) return false;
  const opts = JSON.parse(p.options);
  const finish = (status, fields) => { updatePipeline(id, { status, stage: 'finished', finished_at: nowIso(), ...fields }); return false; };
  const common = { cwd: p.cwd, session: p.session, pipeline_id: id };
  const ov = (stage) => opts.overrides?.[stage] ?? {};

  if (p.cancel_requested) {
    const cur = p.current_run && getRun(p.current_run);
    if (cur && IN_PROGRESS.includes(cur.status)) { try { cancelRun(cur.id); } catch { /* already stopping */ } }
    return finish('cancelled', {});
  }
  if (!p.current_run) { // just started
    const r = startRun('plan', { ...common, input: p.task, context_runs: opts.context_runs, overrides: ov('plan') });
    updatePipeline(id, { current_run: r.run_id, plan_run: r.run_id, stage: 'plan' });
    return true;
  }

  let run = getRun(p.current_run);
  if (IN_PROGRESS.includes(run.status)) return true;
  if (run.status === 'waiting') { if (p.status !== 'waiting') updatePipeline(id, { status: 'waiting' }); return true; }
  if (run.status === 'answered') { // follow the run that continues the answered one
    const next = resumedBy(run.id);
    if (!next) return true;
    const field = { plan: 'plan_run', execute: 'exec_run', fix: 'exec_run', review: 'review_run' }[p.stage];
    updatePipeline(id, { status: 'running', current_run: next, [field]: next });
    return true;
  }
  const writeStage = p.stage === 'execute' || p.stage === 'fix';
  if (!(run.status === 'done' || (writeStage && run.status === 'verify_failed'))) {
    return finish('failed', { error: `${p.stage} run ${run.id} ended ${run.status}${run.error ? `: ${run.error.slice(0, 500)}` : ''}${run.stop_reason ? ` (${run.stop_reason})` : ''}` });
  }

  const startReview = (target) => {
    const r = startRun('review', { ...common, target_run: target, overrides: ov('review') });
    updatePipeline(id, { stage: 'review', current_run: r.run_id, review_run: r.run_id });
    return true;
  };
  const startFix = (instruction) => {
    const r = resumeRun(p.exec_run, instruction, { session: p.session });
    updatePipeline(id, { stage: 'fix', current_run: r.run_id, exec_run: r.run_id, fix_rounds: p.fix_rounds + 1 });
    return true;
  };
  const roundsLeft = p.fix_rounds < opts.max_fix_rounds && !!getRun(p.exec_run ?? run.id)?.native_session;
  const summary = (verdict, note) => JSON.stringify({ verdict, note, branch: getRun(p.exec_run)?.branch,
    execute_run: p.exec_run, review_run: p.review_run, fix_rounds: p.fix_rounds });

  switch (p.stage) {
    case 'plan': {
      const r = startRun('execute', { ...common, plan_id: run.id,
        overrides: { ...ov('execute'), ...(opts.verify ? { verify: opts.verify } : {}) } });
      updatePipeline(id, { stage: 'execute', current_run: r.run_id, exec_run: r.run_id });
      return true;
    }
    case 'execute':
    case 'fix':
      if (run.status === 'verify_failed' && roundsLeft) {
        return startFix(`Kraken ran the verify command "${run.verify_cmd}" and it failed (exit ${run.verify_exit}). ` +
          `Fix the cause, without weakening or skipping the checks.\n\nLast output:\n${run.verify_output ?? ''}`);
      }
      return startReview(run.id);
    case 'review': {
      if (run.verdict === 'approve') {
        if (approvalMode() === 'auto') {
          let m;
          try { m = mergeRun(p.exec_run); } catch (e) { m = { auto_merge_blocked_by: [e.message] }; }
          if (m.outcome === 'merged') return finish('done', { result: summary('approve', `merged automatically as ${m.merge_commit}`) });
          return finish('done', { result: summary('approve', `not merged automatically: ${m.auto_merge_blocked_by.join('; ')}`) });
        }
        return finish('done', { result: summary('approve', 'ready to merge after the developer approves') });
      }
      if (run.verdict === 'changes_requested' && roundsLeft) {
        return startFix(`A reviewer looked at your changes and requested changes. Address every blocker and major ` +
          `finding below (minor ones where cheap), keep the scope, and summarize what you changed.\n\n${run.result}`);
      }
      const note = run.verdict === 'changes_requested'
        ? `the review still requests changes after ${p.fix_rounds} fix round(s); show the findings to the developer`
        : 'the review gave no verdict; read it before merging';
      return finish('done', { result: summary(run.verdict ?? 'none', note) });
    }
    default: return false;
  }
}
