// Control tools: cancel and resume (which also answers a waiting run). No agent and no tokens,
// except resume, which continues a run's native agent session.
import { existsSync } from 'node:fs';
import { resolveAgent } from './agents.js';
import { renderResumePrompt } from './tentacles.js';
import { IN_PROGRESS, newId, insertRun, getRun, updateRun, addMessage, nowIso } from './store.js';
import { alive, killTree } from './platform.js';
import { pump, queueInfo, firstStatus } from './scheduler.js';
import { ensureWorktree, tryGit } from './git.js';
import { parseJson, fail } from './util.js';
import { startCard } from './feed.js';

export function mustRun(id) {
  const run = getRun(id);
  if (!run) fail(`no run ${id}`);
  return run;
}


// ---- cancel ----

export function cancelRun(id) {
  const run = mustRun(id);
  if (!IN_PROGRESS.includes(run.status)) {
    return { run_id: id, status: run.status, changed: false, note: 'run is not in progress' };
  }
  if (run.status === 'queued' && !(run.pid > 0)) {
    // A claimed worker sees this and exits.
    updateRun(id, { status: 'cancelled', finished_at: nowIso() });
    addMessage({ session: run.session, run_id: id, sender: 'kraken', kind: 'cancelled',
      body: 'cancelled before start' });
    return { run_id: id, status: 'cancelled', changed: true };
  }
  if (alive(run.pid)) {
    // The worker polls this flag, stops the agent's process tree and records 'cancelled'.
    updateRun(id, { cancel_requested: 1 });
    const next = `status("${id}", wait_seconds: 15) to confirm`;
    return { run_id: id, status: 'cancelling', changed: true, next };
  }
  // Worker is gone (crash/reboot): stop any orphaned agent tree and record it.
  killTree(run.agent_pid);
  const error = 'worker was not running; marked cancelled';
  updateRun(id, { status: 'cancelled', finished_at: nowIso(), error });
  return { run_id: id, status: 'cancelled', changed: true, note: 'worker was not running' };
}

// ---- resume / answer ----

// Continue a finished or waiting run in its native agent session, in the same workdir/branch.
export function resumeRun(id, input, { session, answering = false, syncBase, merging = false } = {}) {
  const prev = mustRun(id);
  if (IN_PROGRESS.includes(prev.status)) fail(`${id} is still ${prev.status}`);
  if (prev.status === 'cancelled') fail(`${id} was cancelled; start a new run instead`);
  if (prev.outcome) fail(`${id} was already ${prev.outcome}; start a new run instead`);
  if (!prev.native_session) fail(`${id} has no agent session to resume`);
  if (answering && prev.status !== 'waiting') {
    fail(`${id} is not waiting for an answer (status ${prev.status})`);
  }
  if (!prev.branch && !existsSync(prev.workdir)) fail(`workdir is gone: ${prev.workdir}`);
  // A deleted worktree comes back from its branch (it holds all committed work).
  ensureWorktree(prev);
  if (!merging && prev.branch && tryGit(prev.workdir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')) {
    fail(`a merge is in progress in ${prev.workdir}; ` +
      `finish it with resume on the newest run of ${prev.branch}`);
  }
  resolveAgent(prev.agent);

  const text = answering
    ? `The developer answered your question.\nQUESTION: ${prev.question}\nANSWER: ${input}\n\n` +
      'Continue the task.'
    : input;
  const newRunId = newId(`${prev.tentacle.slice(0, 6)}r`);
  insertRun({
    id: newRunId, session: session ?? prev.session, tentacle: prev.tentacle, access: prev.access,
    plan_id: prev.plan_id,
    task: prev.task, agent: prev.agent, model: prev.model, effort: prev.effort,
    prompt: renderResumePrompt(prev.access, prev.workdir, text),
    config: { resumed_from: id, answering, limits: prevLimits(prev), sync_base: syncBase,
      needs_diff: prevNeedsDiff(prev) || undefined, ...carried(prev, merging) },
    timeout_min: prev.timeout_min, cwd: prev.cwd, workdir: prev.workdir, branch: prev.branch,
    verify_cmd: prev.verify_cmd, base_sha: prev.base_sha, resumed_from: id,
    native_session: prev.native_session,
    target_run: prev.target_run, chain_id: prev.chain_id, chain_stage: prev.chain_stage,
  });
  if (answering) {
    updateRun(id, { status: 'answered' });
    addMessage({ session: prev.session, run_id: id, sender: 'developer', kind: 'answer', body: input });
  }
  pump();
  return {
    card: startCard(getRun(newRunId)),
    run_id: newRunId, resumes: id, queue: queueInfo(newRunId), tentacle: prev.tentacle, status: 'queued',
    agent: prev.agent, model: prev.model,
    workdir: prev.workdir, branch: prev.branch ?? undefined,
    next: firstStatus(newRunId),
  };
}

const prevLimits = (run) => parseJson(run.config, {}).limits;
// What a resumed run keeps from the run it continues: the stage progress (so it runs the stages that
// are left), the stage prompt and the shell settings. A conflict merge never continues stages.
function carried(run, merging) {
  const c = parseJson(run.config, {});
  const s = c.settings ?? {};
  const settings = { stage_verify: s.stage_verify ?? undefined,
    verify_timeout_min: s.verify_timeout_min ?? undefined };
  return {
    settings: c.settings ? settings : undefined,
    plan_file: c.plan_file,
    stages: merging ? undefined : c.stages,
    stage_base_prompt: merging ? undefined : c.stage_base_prompt,
  };
}
const prevNeedsDiff = (run) => !!parseJson(run.config, {}).needs_diff;
