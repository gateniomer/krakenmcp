// End to end: chains (stages, pauses, fix rounds, merging, chain files).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, sleep } from './helpers.js';

let h, k;
before(async () => { h = setup(); k = await h.client(); });
after(() => h.cleanup());

// Follows a chain until it is no longer running (done, failed, cancelled, or waiting).
async function waitChain(c, id, { answer } = {}) {
  for (;;) {
    const s = await c.call('status', { run_id: id, wait_seconds: 20 });
    if (s.status === 'waiting' && !s.pause && answer) { await c.call('resume', { run_id: s.current.id, input: answer }); continue; }
    if (s.status !== 'running') return s;
  }
}
// Plan and execute with autonomy auto: the default chain runs straight through to its review.
const autoStages = (on, extra = {}) => {
  h.tentacle('plan', on ? { autonomy: 'auto' } : null);
  h.tentacle('execute', on ? { autonomy: 'auto', ...extra } : null);
};
const chainDir = () => join(h.env.KRAKEN_DATA, 'chains');
const writeChain = (name, text) => { mkdirSync(chainDir(), { recursive: true }); writeFileSync(join(chainDir(), `${name}.md`), text); };

test('chain, default settings: pauses after plan and after execute, then ends with the merge as the next step', async () => {
  const p = await k.call('chain', { task: 'add a feature file', cwd: h.repo, verify: 'node -e "process.exit(0)"' });
  assert.match(p.chain_id, /^chain_/);
  assert.deepEqual(p.stages, ['plan', 'execute', 'review']);
  let s = await waitChain(k, p.chain_id);
  assert.equal(s.status, 'waiting', s.error);
  assert.deepEqual({ reason: s.pause.reason, after: s.pause.after, next_stage: s.pause.next_stage },
    { reason: 'approval', after: 'plan', next_stage: 'execute' });
  assert.match(s.next, new RegExp(`^ask:.*resume\\("${p.chain_id}"`));
  assert.equal(h.db().prepare('SELECT pid FROM chains WHERE id = ?').get(p.chain_id).pid, null, 'no driver while paused');
  await sleep(1200);
  assert.equal((await k.call('status', { run_id: p.chain_id })).status, 'waiting', 'a paused chain survives pump()');
  assert.equal((await k.call('status', { run_id: s.runs.plan })).next, `this run is a stage of chain ${p.chain_id}; follow status("${p.chain_id}")`);

  await k.call('resume', { run_id: p.chain_id, input: 'go, keep it small' });
  s = await waitChain(k, p.chain_id);
  assert.equal(s.pause?.after, 'execute', JSON.stringify(s));
  assert.match(h.row(s.runs.execute).prompt, /Developer note for this step: go, keep it small/);
  assert.equal(h.row(s.runs.execute).chain_id, p.chain_id);
  assert.equal(h.row(s.runs.execute).chain_stage, 1);

  await k.call('resume', { run_id: p.chain_id, input: 'review it' });
  s = await waitChain(k, p.chain_id);
  assert.equal(s.status, 'done', s.error);
  assert.equal(s.result.verdict, 'approve');
  assert.deepEqual(s.summary.milestones.verify, { cmd: 'node -e "process.exit(0)"', exit: 0 });
  assert.equal(h.row(s.runs.execute).plan_id, s.runs.plan);
  assert.equal(h.row(s.runs.review).target_run, s.runs.execute);
  assert.match(s.next, new RegExp(`^ask:.*merge\\("${s.runs.execute}"\\)`));
  assert.equal(h.row(s.runs.execute).outcome, null, 'nothing merged without the developer');
  const ses = await k.call('session', {});
  assert.ok(ses.chains.some((x) => x.id === p.chain_id));
  assert.deepEqual(ses.attention.ready_to_merge, [s.runs.execute], 'the chain\'s branch waits for the developer');
  await k.call('discard', { run_id: s.runs.execute });
});

test('chain: with plan and execute on auto it runs through; review autonomy auto merges verified work', async () => {
  autoStages(true);
  const s = await waitChain(k, (await k.call('chain', { task: 'straight through', cwd: h.repo })).chain_id);
  assert.equal(s.status, 'done', s.error);
  assert.ok(s.runs.plan && s.runs.execute && s.runs.review);
  assert.equal(s.stage_index, '3 of 3');
  assert.match(s.next, /^ask:.*merge\(/);
  await k.call('discard', { run_id: s.runs.execute });

  h.tentacle('review', { autonomy: 'auto' });
  // A verify the head passes itself does not count: it could pass "true".
  const c = await waitChain(k, (await k.call('chain', { task: 'add a self-verified file', cwd: h.repo, verify: 'true' })).chain_id);
  assert.match(c.result.note, /not merged automatically: its verify command was passed in the call/);
  assert.match(c.next, /^ask:.*merge\(/);
  await k.call('discard', { run_id: c.runs.execute });

  autoStages(true, { verify: 'node -e "process.exit(0)"' });
  const m = await waitChain(k, (await k.call('chain', { task: 'add an auto file', cwd: h.repo })).chain_id);
  assert.match(m.result.note, /merged automatically as [0-9a-f]+/);
  assert.equal(h.row(m.runs.execute).outcome, 'merged');
  assert.match(m.next, /^stop: it landed as [0-9a-f]+/);
  assert.match(h.git('log', '-1', '--format=%s'), new RegExp(`Merge kraken/${m.runs.execute}`));

  // No verify command: nothing merges by itself, and merge shows the preview with the reason.
  autoStages(true);
  const q = await waitChain(k, (await k.call('chain', { task: 'add an unverified file', cwd: h.repo })).chain_id);
  assert.match(q.result.note, /not merged automatically: it has no verify command/);
  const preview = await k.call('merge', { run_id: q.runs.execute });
  assert.equal(preview.preview, true);
  assert.equal(preview.review_autonomy, 'auto');
  assert.deepEqual(preview.auto_merge_blocked_by, ['it has no verify command (merging without a preview needs verified work)']);
  await k.call('discard', { run_id: q.runs.execute });
  h.tentacle('review', null); autoStages(false);
});

test('chain: changes_requested triggers a fix round without pausing, then a second review', async () => {
  autoStages(true);
  const c = await h.client({ STUB_VERDICT: 'changes_requested' });
  const s = await waitChain(c, (await c.call('chain', { task: 'fix me', cwd: h.repo, max_fix_rounds: 1 })).chain_id);
  assert.equal(s.status, 'done');
  assert.equal(s.pause, undefined, 'review is ask, but fix rounds never pause');
  assert.equal(s.result.verdict, 'changes_requested');
  assert.match(s.result.note, /after 1 fix round/);
  assert.equal(s.fix_rounds, '1 of 1');
  const fix = h.row(s.runs.execute);
  assert.ok(fix.resumed_from, 'the fix resumed the executor');
  assert.equal(fix.chain_stage, 1);
  assert.match(fix.prompt, /requested changes[\s\S]*\[major\] math\.js:1/);
  assert.equal(h.row(s.runs.review).target_run, fix.id, 'the second review looked at the fixed branch');
  assert.match(s.next, new RegExp(`^ask:.*resume\\("${fix.id}"`));
  await c.call('discard', { run_id: fix.id });
  await c.close();
  autoStages(false);
});

test('chain: a failing verify gets a fix round; with no rounds left it pauses as verify_failed', async () => {
  autoStages(true);
  const fails = 'node -e "console.log(\'boom\');process.exit(3)"';
  const s = await waitChain(k, (await k.call('chain', { task: 'verify fails', cwd: h.repo, verify: fails })).chain_id);
  assert.equal(s.fix_rounds, '1 of 1');
  assert.match(h.row(s.runs.execute).prompt, /failed \(exit 3\)[\s\S]*boom/);
  assert.equal(s.status, 'waiting', 'the fix failed verify too: no rounds left');
  assert.equal(s.pause.reason, 'verify_failed');
  await k.call('cancel', { run_id: s.id });
  await k.call('discard', { run_id: s.runs.execute });

  const p = await k.call('chain', { task: 'verify fails once', cwd: h.repo, max_fix_rounds: 0, verify: 'test -f fixed.txt' });
  let z = await waitChain(k, p.chain_id);
  assert.equal(z.status, 'waiting');
  assert.equal(z.pause.reason, 'verify_failed');
  assert.match(z.next, /^stop:.*resume\(/);
  writeFileSync(join(h.row(z.runs.execute).workdir, 'fixed.txt'), 'ok\n'); // the "fix" the developer asked for
  assert.equal((await k.call('resume', { run_id: p.chain_id, input: 'fix it' })).continues_with, 'fix');
  z = await waitChain(k, p.chain_id);
  assert.equal(z.status, 'done', z.error);
  assert.ok(z.runs.review, 'it went on to the review');
  assert.equal(z.fix_rounds, '0 of 0', 'a fix the developer asked for is not a fix round');
  assert.equal(h.row(z.runs.execute).prompt.includes('fix it'), true);
  await k.call('discard', { run_id: z.runs.execute });
  autoStages(false);
});

test('chain: questions pause it as waiting; answering the run lets it continue by itself', async () => {
  autoStages(true);
  const c = await h.client({ STUB_QUESTION: '1' });
  const p = await c.call('chain', { task: 'needs a decision', cwd: h.repo });
  const s = await waitChain(c, p.chain_id);
  assert.equal(s.status, 'waiting');
  assert.equal(s.pause, undefined);
  assert.equal(s.stage, 'plan');
  assert.equal(s.question, 'Keep it in a separate file?');
  assert.match(s.next, new RegExp(`^ask:.*resume\\("${s.current.id}"`));
  assert.match((await c.raw('resume', { run_id: p.chain_id, input: 'yes' })).text, /answer the stage run instead/);
  const done = await waitChain(c, p.chain_id, { answer: 'yes' });
  assert.equal(done.status, 'done', done.error);
  assert.ok(h.row(done.runs.plan).resumed_from, 'the plan the chain used is the answered one');
  await c.call('discard', { run_id: done.runs.execute });
  await c.close();
  autoStages(false);
});

test('chain: cancel works on a paused chain', async () => {
  const p = await k.call('chain', { task: 'pause then cancel', cwd: h.repo });
  const s = await waitChain(k, p.chain_id);
  assert.equal(s.pause.reason, 'approval');
  assert.equal((await k.call('cancel', { run_id: p.chain_id })).status, 'cancelled');
  const after = await k.call('status', { run_id: p.chain_id });
  assert.equal(after.status, 'cancelled');
  assert.match(after.next, /^stop:.*cancelled/);
  assert.match((await k.raw('resume', { run_id: p.chain_id, input: 'go' })).text, /is cancelled, not paused/);
});

test('chain files: a read-only chain runs outside git; stage autonomy and a user default.md apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraken-nogit-'));
  writeChain('look', '---\ndescription: look around\nstages: [{"tentacle": "explain", "autonomy": "auto"}, {"tentacle": "plan"}]\n---\n');
  const t = await k.call('tentacles', { cwd: h.repo });
  const look = t.chains.find((x) => x.name === 'look');
  assert.deepEqual(look.stages.map((x) => [x.tentacle, x.autonomy, x.autonomy_source]),
    [['explain', 'auto', 'chain look'], ['plan', 'ask', 'built-in']]);
  const s = await waitChain(k, (await k.call('chain', { name: 'look', task: 'the math module', cwd: dir })).chain_id);
  assert.equal(s.status, 'done', s.error);
  assert.equal(s.result.note, 'all stages done');
  assert.ok(h.row(s.runs.plan).prompt.includes(`CONTEXT: explain run ${s.runs.explain}`), 'later read stages see earlier results');
  assert.match(s.next, new RegExp(`^ask:.*execute\\("${s.runs.plan}"\\)`));
  rmSync(dir, { recursive: true, force: true });

  writeChain('default', '---\nmax_fix_rounds: 0\n---\n');
  autoStages(true);
  const c = await h.client({ STUB_VERDICT: 'changes_requested' });
  const z = await waitChain(c, (await c.call('chain', { task: 'no fixes', cwd: h.repo })).chain_id);
  assert.equal(z.fix_rounds, '0 of 0');
  assert.match(z.result.note, /after 0 fix round/);
  await c.call('discard', { run_id: z.runs.execute });
  await c.close();
  rmSync(join(chainDir(), 'default.md'));
  autoStages(false);
});

test('chain: bad names, bad files and bad overrides are errors before anything runs', async () => {
  assert.match((await k.raw('chain', { name: 'nope', task: 'x', cwd: h.repo })).text, /Unknown chain "nope"; known: default/);
  writeChain('broken', '---\nstages: [{"tentacle": "review"}, {"tentacle": "execute"}]\n---\n');
  const e = (await k.raw('chain', { name: 'broken', task: 'x', cwd: h.repo })).text;
  assert.match(e, /cannot run/);
  assert.match(e, /needs a plan/);
  assert.match(e, /must come after the write stage/);
  rmSync(join(chainDir(), 'broken.md'));
  assert.match((await k.raw('chain', { task: 'x', cwd: h.repo, overrides: [{ stage: 'reveiw', agent: 'opencode' }] })).text,
    /override names stage "reveiw"; chain default has: plan, execute, review/);
});

test('chain: cancel stops the current step; a dead driver is marked failed', async () => {
  const slow = await h.client({ STUB_SLEEP: '20' });
  const p = await slow.call('chain', { task: 'slow', cwd: h.repo, overrides: [{ stage: 'plan', agent: 'opencode' }] });
  let s;
  for (let i = 0; i < 50; i++) { s = await slow.call('status', { run_id: p.chain_id }); if (s.current?.status === 'running') break; await sleep(200); }
  assert.equal((await slow.call('cancel', { run_id: p.chain_id })).status, 'cancelling');
  s = await waitChain(slow, p.chain_id);
  assert.equal(s.status, 'cancelled');
  for (let i = 0; i < 50 && h.row(s.runs.plan).status !== 'cancelled'; i++) await sleep(200);
  assert.equal(h.row(s.runs.plan).status, 'cancelled');

  const p2 = await slow.call('chain', { task: 'driver dies', cwd: h.repo });
  await sleep(500);
  const pid = h.db().prepare('SELECT pid FROM chains WHERE id = ?').get(p2.chain_id).pid;
  process.kill(pid, 'SIGKILL');
  await sleep(300);
  const dead = await slow.call('status', { run_id: p2.chain_id });
  assert.equal(dead.status, 'failed');
  assert.match(dead.error, /chain driver exited unexpectedly/);
  assert.match(dead.next, /report this error to the developer/);
  if (dead.runs.plan) await slow.call('cancel', { run_id: dead.runs.plan });
  await slow.close();
});
