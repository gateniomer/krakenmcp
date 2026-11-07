// Views of one run: its metrics, its `next` step, and the full status reply (describe).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS } from './agents.js';
import { PLANS_DIR, LOGS_DIR, IN_PROGRESS, recentMessages, lastMessageId, latestReview, resumedBy } from './store.js';
import { queueInfo } from './scheduler.js';
import { resolveTentacle, stageKind } from './tentacles.js';
import { parseJson as parse, toDate } from './util.js';

export const clip = (s, n = 1500) => (s && s.length > n ? `${s.slice(0, n)}\n…[truncated, ${s.length} chars]` : s);
const ms = (a, b) => (a && b ? toDate(b) - toDate(a) : undefined);

// Metrics an agent's output does not contain, so they read "not reported" instead of zero.
export function notReported(agent) {
  const r = AGENTS[agent]?.reports;
  return r ? Object.entries(r).filter(([, v]) => !v).map(([k]) => k) : [];
}

export function metrics(run) {
  const end = run.finished_at ?? (run.started_at ? new Date().toISOString() : null);
  const missing = notReported(run.agent);
  return {
    not_reported: missing.length ? missing : undefined,
    queue_ms: ms(run.created_at, run.started_at),
    duration_ms: run.duration_ms ?? ms(run.started_at, end), // live elapsed while running
    tokens: parse(run.tokens),
    cost_usd: run.cost_usd ?? undefined,
    steps: run.steps ?? undefined,
    tool_calls: parse(run.tool_calls),
    diff: parse(run.diff_stat),
    exit_code: run.exit_code ?? undefined,
  };
}

// A run that ended badly must not be retried silently on another agent or model.
export const STOP_NEXT = 'stop: report this error to the developer and ask how to proceed; ' +
  'do not retry or switch agent/model on your own';
const STOP = ['failed', 'timeout', 'over_budget'];

// The one step after a finished run. ask: = show the result, suggest exactly that step and wait;
// auto: = the developer allowed the head to take it; stop: = report and wait. Hard stops (questions,
// failures, verify_failed) never depend on autonomy. Pure, so it is unit-tested on its own.
export function finishedNext(f) {
  const mode = f.autonomy === 'auto' ? 'auto' : 'ask';
  if (f.status === 'waiting') return `ask: put the question to the developer, then resume("${f.id}", their reply)`;
  if (STOP.includes(f.status)) return STOP_NEXT;
  if (f.status === 'cancelled') return 'stop: tell the developer it was cancelled and wait';
  if (f.chain_id) return `this run is a stage of chain ${f.chain_id}; follow status("${f.chain_id}")`;
  if (f.status === 'answered' || f.newer_run) return f.newer_run ? `follow status("${f.newer_run}")` : undefined;
  if (f.outcome) return `stop: it was ${f.outcome}; ask the developer what is next`;
  if (f.status === 'verify_failed') {
    return `stop: show the verify output; suggest resume("${f.id}", "fix the failing check") or discard("${f.id}")`;
  }
  if (f.status !== 'done') return undefined;
  if (f.kind === 'write') return `${mode}: show the diff stat and verify result; suggest review(run_id: "${f.id}")`;
  if (f.kind === 'review') {
    if (!f.target_run) return 'ask: show the findings; the changes are the developer\'s own, nothing to merge';
    if (f.verdict === 'approve') {
      return mode === 'auto'
        ? `auto: call merge("${f.target_run}"); it lands at once if nothing blocks it, otherwise show the preview`
        : `ask: show the verdict; suggest merge("${f.target_run}")`;
    }
    if (f.verdict === 'changes_requested') {
      return `${mode}: show the findings; suggest resume("${f.target_run}", "address the review findings"), then review again`;
    }
    return 'ask: show the review; ask the developer how to proceed';
  }
  if (f.tentacle === 'think') {
    return mode === 'auto'
      ? `auto: if it has no open questions call plan(task, context_runs: ["${f.id}"]); otherwise ask them first`
      : `ask: relay the recommendation and its open questions; suggest plan(task + their answers, context_runs: ["${f.id}"])`;
  }
  if (f.tentacle === 'plan') return `${mode}: summarize the plan (result_file); suggest execute("${f.id}")`;
  return `${mode}: give the developer result_file and a short summary; suggest plan(task, context_runs: ["${f.id}"]) if they want a change`;
}

// Kind and autonomy of a run's tentacle as the files say now (an edit applies to the next step).
export function runFacts(run, { chain = true } = {}) {
  let kind = run.access === 'write' ? 'write' : run.target_run || run.tentacle === 'review' ? 'review' : 'read';
  let autonomy = 'ask';
  try { const t = resolveTentacle(run.tentacle, run.cwd); kind = stageKind(t); autonomy = t.autonomy; } catch { /* tentacle file gone */ }
  return { id: run.id, tentacle: run.tentacle, kind, status: run.status, verdict: run.verdict, target_run: run.target_run,
    outcome: run.outcome, autonomy, newer_run: resumedBy(run.id), chain_id: chain ? run.chain_id : null };
}

export function describe(run, full = false) {
  const resultFile = join(PLANS_DIR, `${run.id}.md`);
  return {
    id: run.id, tentacle: run.tentacle, access: run.access, status: run.status,
    queue: queueInfo(run.id),
    agent: run.agent, model: run.model, effort: run.effort,
    task: clip(run.task, 200), plan_id: run.plan_id ?? undefined,
    question: run.status === 'waiting' ? run.question : undefined,
    ...nextOf(run),
    outcome: run.outcome ? `${run.outcome}: ${run.outcome_detail}` : undefined,
    verdict: run.verdict ?? undefined, target_run: run.target_run ?? undefined,
    resumed_from: run.resumed_from ?? undefined,
    review: run.access === 'write' && run.branch ? latestReview(run.id) ?? undefined : undefined,
    result_file: existsSync(resultFile) ? resultFile : undefined,
    workdir: run.workdir, branch: run.branch ?? undefined,
    result: full ? run.result : clip(run.result),
    error: run.error ?? undefined,
    stopped: run.stop_reason ?? undefined,
    chain: run.chain_id ?? undefined,
    metrics: metrics(run),
    verify: run.verify_cmd
      ? { cmd: run.verify_cmd, exit: run.verify_exit, output: full ? run.verify_output : clip(run.verify_output, 600) }
      : undefined,
    log: join(LOGS_DIR, `${run.id}.log`),
    recent_messages: recentMessages(run.id),
    cursor: lastMessageId(run.id),
  };
}

export function nextOf(run) {
  if (IN_PROGRESS.includes(run.status)) return {};
  const f = runFacts(run);
  return { next: finishedNext(f), autonomy: f.autonomy };
}

