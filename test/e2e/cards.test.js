// End to end: the bordered cards the head shows when it calls a tentacle, on every poll, and at the end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let h, k;
before(async () => { h = setup(); k = await h.client(); });
after(() => h.cleanup());

const cols = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) >= 0x1f000 ? 2 : 1), 0);
function assertBox(card) {
  const lines = card.split('\n');
  assert.match(lines[0], /^╭─ 🦑 /);
  assert.match(lines.at(-1), /^╰─+╯$/);
  for (const l of lines.slice(1, -1)) assert.match(l, /^│ .* │$/, l);
  assert.equal(new Set(lines.map(cols)).size, 1, `every line is as wide as the others:\n${card}`);
  if (process.env.SHOW_CARDS) console.log(card);
}

test('a run has a card when it is called, on every poll, and when it ends', async () => {
  const c = await h.client({ STUB_SLEEP: '3' });
  const start = await c.call('explain', { area: 'the math module', cwd: h.repo });
  assertBox(start.card);
  assert.match(start.card, /🦑 explain › opencode .*○ queued|● running/);
  assert.match(start.card, new RegExp(`run +${start.run_id}`));
  assert.match(start.card, /task +the math module/);

  const live = await c.call('status', { run_id: start.run_id, wait_seconds: 1, since: 0 });
  assert.equal(live.status, 'running');
  assertBox(live.card);
  assert.match(live.card, /● running/);
  assert.match(live.card, /now +/);
  assert.match(live.next, /^show card as-is .*even if there are none/);

  const done = await c.wait(start.run_id);
  assertBox(done.card);
  assert.match(done.card, /✓ done/);
  assert.match(done.card, /result +~?\//);
  assert.match(done.card, /next +ask:/);
  await c.close();
});

test('a write run card shows its branch, diff and verify; a failure shows the error', async () => {
  const plan = await k.wait((await k.call('plan', { task: 'add a file', cwd: h.repo })).run_id);
  const start = await k.call('execute', { plan_id: plan.id, verify: 'echo ok' });
  assert.match(start.card, /branch +kraken\/execute_/);
  assert.match(start.card, /verify +echo ok/);
  const e = await k.wait(start.run_id);
  assertBox(e.card);
  assert.match(e.card, /branch +kraken\/execute_\S+ \(1 file, \+1 −0\)/);
  assert.match(e.card, /verify +echo ok → exit 0/);
  const r = await k.wait((await k.call('review', { run_id: e.id })).run_id);
  assert.match(r.card, /verdict +approve/);
  assert.match(r.card, /next +ask: show the verdict; suggest/);
  const resumed = await k.call('resume', { run_id: e.id, input: 'one more thing' });
  assert.match(resumed.card, new RegExp(`\\(resumes ${e.id}\\)`));
  await k.wait(resumed.run_id);
  await k.call('discard', { run_id: e.id });

  const bad = await h.client({ STUB_EXIT: '3' });
  const f = await bad.wait((await bad.call('explain', { area: 'x', cwd: h.repo })).run_id);
  assertBox(f.card);
  assert.match(f.card, /✕ failed/);
  assert.match(f.card, /error +exit 3: stub failure/);
  assert.match(f.card, /next +stop:/);
  await bad.close();
});

test('a chain card marks every stage and says why it paused', async () => {
  const p = await k.call('chain', { task: 'add a feature file', cwd: h.repo });
  assertBox(p.card);
  assert.match(p.card, /🦑 chain default › plan/);
  assert.match(p.card, /stages +plan ● → execute · → review ·/);
  let s;
  for (;;) { s = await k.call('status', { run_id: p.chain_id, wait_seconds: 20 }); if (s.status !== 'running') break; }
  assertBox(s.card);
  assert.match(s.card, /◐ paused/);
  assert.match(s.card, /stages +plan ✓ → execute · → review ·/);
  assert.match(s.card, /paused +after plan; resume to continue to execute/);
  assert.match(s.card, /next +ask:/);
  const r = await k.call('resume', { run_id: p.chain_id, input: 'go' });
  assertBox(r.card);
  await k.call('cancel', { run_id: p.chain_id });
  for (;;) { s = await k.call('status', { run_id: p.chain_id, wait_seconds: 20 }); if (!['running', 'waiting'].includes(s.status)) break; }
  assert.match(s.card, /⊘ cancelled/);
  if (s.branch_run) await k.call('discard', { run_id: s.branch_run }).catch(() => {});
});
