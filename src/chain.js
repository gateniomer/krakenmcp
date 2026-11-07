// Chains: run an ordered list of tentacle stages (chains.js loads them) by themselves.
//
// Kraken drives the stages (chain-driver.js, a detached process like the worker), so agents still
// never delegate to agents. After a successful stage the stage's autonomy decides: auto starts the
// next stage, ask pauses the chain as "waiting" with a pause, and the driver exits until the
// developer answers with resume(chain_id, reply). Fix rounds (a review that requests changes, or a
// failed verify) resume the write run without pausing, up to max_fix_rounds. The last review's
// autonomy decides merging: auto merges an approved, verified branch when nothing blocks it;
// otherwise the chain ends and the head shows the merge preview. A question from any stage pauses
// the chain as "waiting" without a pause: the head answers that run and the chain follows it.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId, nowIso, getRun, insertChain, getChain, updateChain, resumedBy, IN_PROGRESS, latestReview,
  chainRuns } from './store.js';
import { startNode, firstStatus } from './scheduler.js';
import { cancelRun, resumeRun } from './control.js';
import { mergeRun } from './branches.js';
import { resolveChain, checkChain } from './chains.js';
import { startRun } from './runs.js';
import { chainCard, FINAL } from './chain-view.js';
import { isGitRepo } from './git.js';
import { parseJson as json, fail } from './util.js';

export const isChainId = (id) => typeof id === 'string' && id.startsWith('chain_');


// overrides: [{ stage: <tentacle>, agent?, model?, effort? }] for this call only.
export function startChain({ name = 'default', task, cwd, session = 'default', verify, max_fix_rounds,
  context_runs = [], overrides = [] }) {
  const dir = resolve(cwd ?? process.cwd());
  if (!existsSync(dir)) fail(`cwd does not exist: ${dir}`);
  const chain = resolveChain(name);
  const checked = checkChain(chain, dir);
  if (checked.problems.length) fail(`chain "${name}" cannot run:\n- ${checked.problems.join('\n- ')}`);
  const names = checked.stages.map((s) => s.tentacle);
  for (const o of overrides) {
    if (!names.includes(o.stage)) {
      fail(`override names stage "${o.stage}"; chain ${name} has: ${names.join(', ')}`);
    }
  }
  if (verify && !checked.has_write) fail(`chain ${name} has no write stage, so verify does not apply`);
  if (checked.has_write) {
    if (!isGitRepo(dir)) fail(`${dir} is not a git repo; chain ${name}'s write stage needs a worktree`);
  }
  for (const cid of context_runs) {
    const r = getRun(cid);
    const ok = r?.status === 'done' && r.result;
    if (!ok) fail(`context run ${cid} must exist and be done with a result`);
  }
  const id = newId('chain');
  insertChain({ id, session, name, task, cwd: dir, stages: checked.stages, stage: names[0],
    options: { verify, max_fix_rounds: max_fix_rounds ?? chain.max_fix_rounds, context_runs, overrides } });
  updateChain(id, { pid: startNode('chain-driver.js', id) });
  return { card: chainCard(getChain(id)), chain_id: id, name, status: 'running', stages: names,
    next: firstStatus(id) };
}

export function cancelChain(id) {
  const c = getChain(id);
  if (!c) fail(`no chain ${id}`);
  if (!['running', 'waiting'].includes(c.status)) return { chain_id: id, status: c.status, changed: false };
  if (c.pause) { // paused: no driver is running, so record it here
    updateChain(id, { status: 'cancelled', stage: 'finished', pause: null, finished_at: nowIso() });
    return { chain_id: id, status: 'cancelled', changed: true };
  }
  updateChain(id, { cancel_requested: 1 });
  // Stop the current step now; the driver records the chain as cancelled.
  const cur = c.current_run && getRun(c.current_run);
  if (cur && IN_PROGRESS.includes(cur.status)) cancelRun(cur.id);
  return { chain_id: id, status: 'cancelling', changed: true };
}

// Answer a paused chain. After an approval pause the reply goes to the next stage as a note; after
// a verify_failed pause it is the fix instruction for the write run (not counted as a fix round).
export function resumeChain(id, input) {
  const c = getChain(id);
  if (!c) fail(`no chain ${id}`);
  if (c.status === 'waiting' && !c.pause) {
    fail(`chain ${id} waits on a question: answer the stage run instead: resume("${c.current_run}", …)`);
  }
  if (c.status !== 'waiting') fail(`chain ${id} is ${c.status}, not paused`);
  const pause = json(c.pause, {});
  if (pause.reason === 'verify_failed') {
    const r = resumeRun(c.write_run, input, { session: c.session });
    const fix = { stage: 'fix', current_run: r.run_id, write_run: r.run_id };
    updateChain(id, { status: 'running', pause: null, ...fix });
  } else {
    updateChain(id, { status: 'running', pause: null, note: input ?? null });
  }
  updateChain(id, { pid: startNode('chain-driver.js', id) });
  const continuesWith = pause.reason === 'verify_failed' ? 'fix' : pause.next_stage;
  return { card: chainCard(getChain(id)), chain_id: id, status: 'running', continues_with: continuesWith,
    next: firstStatus(id) };
}

// ---- driver: chain-driver.js calls tick() every second until it returns false ----
// Each step below returns true to keep driving, false to stop (finished or paused).

const VERIFY_FIX = (run) =>
  `Kraken ran the verify command "${run.verify_cmd}" and it failed (exit ${run.verify_exit}). ` +
  'Fix the cause, without weakening or skipping the checks.' +
  `\n\nLast output:\n${run.verify_output ?? ''}`;
const REVIEW_FIX = (run) =>
  'A reviewer looked at your changes and requested changes. Address every blocker and major finding ' +
  'below (minor ones where cheap), keep the scope, and summarize what you changed.' +
  `\n\n${run.result}`;

function finish(ch, status, fields = {}) {
  updateChain(ch.id, { status, stage: 'finished', finished_at: nowIso(), ...fields });
  return false;
}
// The driver exits while paused (pid null); resumeChain starts a new one.
function pauseChain(ch, pause, fields = {}) {
  updateChain(ch.id, { status: 'waiting', pause: JSON.stringify(pause), pid: null, ...fields });
  return false;
}

const roundsLeft = ({ c, opts }) =>
  c.fix_rounds < opts.max_fix_rounds && !!getRun(c.write_run)?.native_session;

// The finished run of every read stage before stage idx (after answers), in stage order.
function earlierReads({ id, stages }, idx) {
  const byStage = new Map();
  for (const r of chainRuns(id)) {
    const st = stages[r.chain_stage];
    if (r.status === 'done' && st?.kind === 'read' && st.index < idx) byStage.set(r.chain_stage, r.id);
  }
  return [...byStage.entries()].sort((a, b) => a[0] - b[0]).map(([, rid]) => rid);
}

// The call's agent/model/effort overrides for one stage.
const callOverrides = ({ opts }, tentacle) => Object.assign({}, ...(opts.overrides ?? [])
  .filter((o) => o.stage === tentacle).map(({ stage, ...rest }) => rest));

// What a stage gets: read stages the task and every earlier read result; the write stage the last
// read result as its plan (and the call's verify); review stages the write stage's branch.
function stageArgs(ch, idx) {
  const { c, opts, stages } = ch, st = stages[idx];
  const base = { cwd: c.cwd, session: c.session, chain_id: ch.id, chain_stage: idx, note: c.note ?? undefined,
    layers: [{ label: `chain ${c.name}`, values: st.layer }], overrides: callOverrides(ch, st.tentacle) };
  const reads = earlierReads(ch, idx);
  const given = opts.context_runs ?? [];
  if (st.kind === 'read') return { ...base, input: c.task, context_runs: [...given, ...reads] };
  if (st.kind === 'review') return { ...base, target_run: c.write_run };
  const verify = opts.verify ? { verify: opts.verify } : {};
  return { ...base, input: c.task, plan_id: reads.at(-1), context_runs: st.needs_plan ? [] : given,
    overrides: { ...base.overrides, ...verify } };
}

function startStage(ch, idx) {
  const st = ch.stages[idx];
  const r = startRun(st.tentacle, stageArgs(ch, idx));
  const write = st.kind === 'write' ? { write_run: r.run_id } : {};
  updateChain(ch.id, { status: 'running', stage: st.tentacle, stage_index: idx, current_run: r.run_id,
    note: null, ...write });
  return true;
}

function startFix(ch, instruction) {
  const r = resumeRun(ch.c.write_run, instruction, { session: ch.c.session });
  updateChain(ch.id, { stage: 'fix', current_run: r.run_id, write_run: r.run_id,
    fix_rounds: ch.c.fix_rounds + 1 });
  return true;
}

// A stage succeeded: start the next one (auto), pause for the developer (ask), or finish.
function advance(ch, idx, run) {
  const { stages } = ch, st = stages[idx], next = stages[idx + 1];
  if (!next) return finishLast(ch);
  if (st.autonomy === 'auto') return startStage(ch, idx + 1);
  const pause = { reason: 'approval', after: st.tentacle, after_run: run.id, next_stage: next.tentacle };
  return pauseChain(ch, pause, { stage_index: idx + 1, stage: next.tentacle, current_run: null });
}

// How the chain ends: a note, plus merge_commit when the last review's autonomy merged it.
function landing(c, write, verdict, reviews) {
  if (!reviews.length) return { note: 'no review stage; review the branch before merging' };
  if (verdict === 'changes_requested') {
    const rounds = `${c.fix_rounds} fix round(s)`;
    return { note: `the review still requests changes after ${rounds}; show the findings to the developer` };
  }
  if (verdict !== 'approve') return { note: 'the review gave no verdict; read it before merging' };
  if (reviews.at(-1).autonomy !== 'auto') return { note: 'ready to merge after the developer approves' };
  let m;
  try {
    m = mergeRun(write.id, undefined, { autonomy: 'auto' });
  } catch (e) {
    m = { auto_merge_blocked_by: [e.message] };
  }
  const commit = m.outcome === 'merged' ? m.merge_commit : null;
  if (commit) return { merge_commit: commit, note: `merged automatically as ${commit}` };
  return { note: `not merged automatically: ${(m.auto_merge_blocked_by ?? []).join('; ')}` };
}

function finishLast(ch) {
  const { c, stages } = ch;
  const write = c.write_run ? getRun(c.write_run) : null;
  if (!write) return finish(ch, 'done', { result: JSON.stringify({ note: 'all stages done' }) });
  const reviews = stages.filter((s) => s.kind === 'review');
  const verdict = reviews.length ? latestReview(write.id)?.verdict ?? 'none' : undefined;
  const result = { verdict, branch: write.branch, write_run: write.id, fix_rounds: c.fix_rounds,
    ...landing(c, write, verdict, reviews) };
  return finish(ch, 'done', { result: JSON.stringify(result) });
}

function afterWrite(ch, run) {
  const idx = ch.c.stage_index;
  if (run.status === 'verify_failed') {
    if (roundsLeft(ch)) return startFix(ch, VERIFY_FIX(run));
    return pauseChain(ch, { reason: 'verify_failed', after: run.tentacle, after_run: run.id });
  }
  // A fix asked for by a review stage: review again. Otherwise the write stage itself is done.
  return ch.stages[idx].kind === 'review' ? startStage(ch, idx) : advance(ch, idx, run);
}

function afterRead(ch, run) {
  const idx = ch.c.stage_index;
  if (ch.stages[idx].kind === 'review') {
    if (run.verdict === 'changes_requested' && roundsLeft(ch)) return startFix(ch, REVIEW_FIX(run));
    if (run.verdict !== 'approve') return finishLast(ch);
  }
  return advance(ch, idx, run);
}

function cancelNow(ch) {
  const cur = ch.c.current_run && getRun(ch.c.current_run);
  if (cur && IN_PROGRESS.includes(cur.status)) { try { cancelRun(cur.id); } catch { /* already stopping */ } }
  return finish(ch, 'cancelled');
}

// The answered run was continued by a new run (resumed_from): follow it.
function followAnswer(ch, run) {
  const next = resumedBy(run.id);
  if (!next) return true;
  const write = run.access === 'write' ? { write_run: next } : {};
  updateChain(ch.id, { status: 'running', current_run: next, ...write });
  return true;
}

const failure = (c, run) => [
  `${c.stage} run ${run.id} ended ${run.status}`,
  run.error && `: ${run.error.slice(0, 500)}`,
  run.stop_reason && ` (${run.stop_reason})`,
].filter(Boolean).join('');

export function tick(id) {
  const c = getChain(id);
  if (!c || FINAL.includes(c.status) || c.pause) return false;
  const ch = { id, c, opts: json(c.options, {}), stages: json(c.stages, []) };
  if (c.cancel_requested) return cancelNow(ch);
  // Just started, or resumed after an approval pause.
  if (!c.current_run) return startStage(ch, c.stage_index);
  const run = getRun(c.current_run);
  if (IN_PROGRESS.includes(run.status)) return true;
  if (run.status === 'waiting') {
    if (c.status !== 'waiting') updateChain(id, { status: 'waiting' });
    return true;
  }
  if (run.status === 'answered') return followAnswer(ch, run);
  const isWrite = run.access === 'write';
  const ended = run.status === 'done' || (isWrite && run.status === 'verify_failed');
  if (!ended) return finish(ch, 'failed', { error: failure(c, run) });
  return isWrite ? afterWrite(ch, run) : afterRead(ch, run);
}
