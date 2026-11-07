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
import { startNode } from './scheduler.js';
import { cancelRun, resumeRun } from './control.js';
import { mergeRun } from './branches.js';
import { resolveChain, checkChain } from './chains.js';
import { startRun } from './runs.js';
import { chainCard, FINAL } from './chain-view.js';
import { isGitRepo } from './git.js';
import { parseJson as json } from './util.js';

export const isChainId = (id) => typeof id === 'string' && id.startsWith('chain_');


// overrides: [{ stage: <tentacle>, agent?, model?, effort? }] for this call only.
export function startChain({ name = 'default', task, cwd, session = 'default', verify, max_fix_rounds,
  context_runs = [], overrides = [] }) {
  const dir = resolve(cwd ?? process.cwd());
  if (!existsSync(dir)) throw new Error(`cwd does not exist: ${dir}`);
  const chain = resolveChain(name);
  const checked = checkChain(chain, dir);
  if (checked.problems.length) throw new Error(`chain "${name}" cannot run:\n- ${checked.problems.join('\n- ')}`);
  const names = checked.stages.map((s) => s.tentacle);
  for (const o of overrides) {
    if (!names.includes(o.stage)) throw new Error(`override names stage "${o.stage}"; chain ${name} has: ${names.join(', ')}`);
  }
  if (verify && !checked.has_write) throw new Error(`chain ${name} has no write stage, so verify does not apply`);
  if (checked.has_write) {
    if (!isGitRepo(dir)) throw new Error(`${dir} is not a git repo; chain ${name}'s write stage needs a worktree`);
  }
  for (const cid of context_runs) {
    const r = getRun(cid);
    if (!r || r.status !== 'done' || !r.result) throw new Error(`context run ${cid} must exist and be done with a result`);
  }
  const id = newId('chain');
  insertChain({ id, session, name, task, cwd: dir, stages: checked.stages, stage: names[0],
    options: { verify, max_fix_rounds: max_fix_rounds ?? chain.max_fix_rounds, context_runs, overrides } });
  updateChain(id, { pid: startNode('chain-driver.js', id) });
  return { card: chainCard(getChain(id)), chain_id: id, name, status: 'running', stages: names,
    next: `call status with run_id "${id}", wait_seconds 50 and since 0` };
}

export function cancelChain(id) {
  const c = getChain(id);
  if (!c) throw new Error(`no chain ${id}`);
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
  if (!c) throw new Error(`no chain ${id}`);
  if (c.status === 'waiting' && !c.pause) {
    throw new Error(`chain ${id} waits on a question: answer the stage run instead: resume("${c.current_run}", …)`);
  }
  if (c.status !== 'waiting') throw new Error(`chain ${id} is ${c.status}, not paused`);
  const pause = json(c.pause, {});
  if (pause.reason === 'verify_failed') {
    const r = resumeRun(c.write_run, input, { session: c.session });
    updateChain(id, { status: 'running', pause: null, stage: 'fix', current_run: r.run_id, write_run: r.run_id });
  } else {
    updateChain(id, { status: 'running', pause: null, note: input ?? null });
  }
  updateChain(id, { pid: startNode('chain-driver.js', id) });
  return { card: chainCard(getChain(id)), chain_id: id, status: 'running', continues_with: pause.reason === 'verify_failed' ? 'fix' : pause.next_stage,
    next: `call status with run_id "${id}", wait_seconds 50 and since 0` };
}

// ---- driver: one step of the state machine; chain-driver.js calls it every second ----

export function tick(id) {
  const c = getChain(id);
  if (!c || FINAL.includes(c.status) || c.pause) return false;
  const opts = json(c.options, {});
  const stages = json(c.stages, []);
  const finish = (status, fields) => { updateChain(id, { status, stage: 'finished', finished_at: nowIso(), ...fields }); return false; };
  const pauseHere = (pause, fields = {}) => {
    updateChain(id, { status: 'waiting', pause: JSON.stringify(pause), pid: null, ...fields });
    return false;
  };

  if (c.cancel_requested) {
    const cur = c.current_run && getRun(c.current_run);
    if (cur && IN_PROGRESS.includes(cur.status)) { try { cancelRun(cur.id); } catch { /* already stopping */ } }
    return finish('cancelled', {});
  }

  // The finished, result-bearing run of each earlier stage (following answers and fixes).
  const doneRuns = (pred) => {
    const out = new Map();
    for (const r of chainRuns(id)) if (r.status === 'done' && pred(stages[r.chain_stage])) out.set(r.chain_stage, r.id);
    return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, rid]) => rid);
  };
  const callOverrides = (tentacle) => Object.assign({}, ...(opts.overrides ?? [])
    .filter((o) => o.stage === tentacle).map(({ stage, ...rest }) => rest));

  const startStage = (idx) => {
    const st = stages[idx];
    const base = { cwd: c.cwd, session: c.session, chain_id: id, chain_stage: idx, note: c.note ?? undefined,
      layers: [{ label: `chain ${c.name}`, values: st.layer }], overrides: callOverrides(st.tentacle) };
    const earlierReads = doneRuns((s) => s && s.kind === 'read' && s.index < idx);
    let r;
    if (st.kind === 'read') {
      r = startRun(st.tentacle, { ...base, input: c.task, context_runs: [...(opts.context_runs ?? []), ...earlierReads] });
    } else if (st.kind === 'write') {
      r = startRun(st.tentacle, { ...base, input: c.task, plan_id: earlierReads.at(-1),
        context_runs: st.needs_plan ? [] : opts.context_runs ?? [],
        overrides: { ...base.overrides, ...(opts.verify ? { verify: opts.verify } : {}) } });
    } else {
      r = startRun(st.tentacle, { ...base, target_run: c.write_run });
    }
    updateChain(id, { status: 'running', stage: st.tentacle, stage_index: idx, current_run: r.run_id, note: null,
      ...(st.kind === 'write' ? { write_run: r.run_id } : {}) });
    return true;
  };
  const startFix = (instruction) => {
    const r = resumeRun(c.write_run, instruction, { session: c.session });
    updateChain(id, { stage: 'fix', current_run: r.run_id, write_run: r.run_id, fix_rounds: c.fix_rounds + 1 });
    return true;
  };
  // A successful stage: go on (auto), pause for the developer (ask), or finish after the last one.
  const advance = (idx, run) => {
    const st = stages[idx];
    if (idx + 1 < stages.length) {
      if (st.autonomy === 'auto') return startStage(idx + 1);
      return pauseHere({ reason: 'approval', after: st.tentacle, after_run: run.id, next_stage: stages[idx + 1].tentacle },
        { stage_index: idx + 1, stage: stages[idx + 1].tentacle, current_run: null });
    }
    return finishLast();
  };
  const finishLast = () => {
    const write = c.write_run ? getRun(c.write_run) : null;
    const reviews = stages.filter((s) => s.kind === 'review');
    if (!write) return finish('done', { result: JSON.stringify({ note: 'all stages done' }) });
    const verdict = reviews.length ? latestReview(write.id)?.verdict ?? 'none' : undefined;
    const base = { verdict, branch: write.branch, write_run: write.id, fix_rounds: c.fix_rounds };
    if (verdict !== 'approve') {
      const note = !reviews.length ? 'no review stage; review the branch before merging'
        : verdict === 'changes_requested'
          ? `the review still requests changes after ${c.fix_rounds} fix round(s); show the findings to the developer`
          : 'the review gave no verdict; read it before merging';
      return finish('done', { result: JSON.stringify({ ...base, note }) });
    }
    if (reviews.at(-1).autonomy === 'auto') {
      let m;
      try { m = mergeRun(write.id, undefined, { autonomy: 'auto' }); } catch (e) { m = { auto_merge_blocked_by: [e.message] }; }
      if (m.outcome === 'merged') {
        return finish('done', { result: JSON.stringify({ ...base, merge_commit: m.merge_commit,
          note: `merged automatically as ${m.merge_commit}` }) });
      }
      return finish('done', { result: JSON.stringify({ ...base,
        note: `not merged automatically: ${(m.auto_merge_blocked_by ?? []).join('; ')}` }) });
    }
    return finish('done', { result: JSON.stringify({ ...base, note: 'ready to merge after the developer approves' }) });
  };

  if (!c.current_run) return startStage(c.stage_index); // just started, or resumed after an approval pause

  const run = getRun(c.current_run);
  if (IN_PROGRESS.includes(run.status)) return true;
  if (run.status === 'waiting') { if (c.status !== 'waiting') updateChain(id, { status: 'waiting' }); return true; }
  if (run.status === 'answered') { // follow the run that continues the answered one
    const next = resumedBy(run.id);
    if (!next) return true;
    updateChain(id, { status: 'running', current_run: next, ...(run.access === 'write' ? { write_run: next } : {}) });
    return true;
  }
  const idx = c.stage_index;
  const st = stages[idx];
  const isWrite = run.access === 'write';
  if (!(run.status === 'done' || (isWrite && run.status === 'verify_failed'))) {
    return finish('failed', { error: `${c.stage} run ${run.id} ended ${run.status}${run.error ? `: ${run.error.slice(0, 500)}` : ''}${run.stop_reason ? ` (${run.stop_reason})` : ''}` });
  }
  const roundsLeft = c.fix_rounds < opts.max_fix_rounds && !!getRun(c.write_run)?.native_session;

  if (isWrite) {
    if (run.status === 'verify_failed') {
      if (roundsLeft) {
        return startFix(`Kraken ran the verify command "${run.verify_cmd}" and it failed (exit ${run.verify_exit}). ` +
          `Fix the cause, without weakening or skipping the checks.\n\nLast output:\n${run.verify_output ?? ''}`);
      }
      return pauseHere({ reason: 'verify_failed', after: run.tentacle, after_run: run.id });
    }
    // A fix asked for by a review stage: review again. Otherwise the write stage itself is done.
    if (st.kind === 'review') return startStage(idx);
    return advance(idx, run);
  }
  if (st.kind === 'review') {
    if (run.verdict === 'changes_requested' && roundsLeft) {
      return startFix('A reviewer looked at your changes and requested changes. Address every blocker and major ' +
        `finding below (minor ones where cheap), keep the scope, and summarize what you changed.\n\n${run.result}`);
    }
    if (run.verdict !== 'approve') return finishLast();
  }
  return advance(idx, run);
}
