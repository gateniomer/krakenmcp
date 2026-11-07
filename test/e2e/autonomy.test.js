// End to end: per-tentacle autonomy decides the `next` of a finished run, hard stops win over it,
// and the review tentacle's autonomy decides whether merge lands without a preview.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let h, k;
before(async () => { h = setup(); k = await h.client(); });
after(() => h.cleanup());

test('a tentacle file with autonomy auto turns its next into auto:; other tentacles stay ask', async () => {
  h.tentacle('plan', { autonomy: 'auto' });
  const p = await k.wait((await k.call('plan', { task: 'add a file', cwd: h.repo })).run_id);
  assert.equal(p.autonomy, 'auto');
  assert.match(p.next, new RegExp(`^auto:.*execute\\("${p.id}"\\)`));
  const t = await k.call('tentacles', { cwd: h.repo });
  const plan = t.tentacles.find((x) => x.name === 'plan');
  assert.deepEqual([plan.settings.autonomy, plan.sources.autonomy], ['auto', 'user file']);
  const think = t.tentacles.find((x) => x.name === 'think');
  assert.deepEqual([think.settings.autonomy, think.sources.autonomy], ['ask', 'built-in']);
  h.tentacle('plan', null);
});

test('hard stops win over auto: a failure is stop:, a question is ask:', async () => {
  h.tentacle('explain', { autonomy: 'auto' });
  const bad = await h.client({ STUB_EXIT: '3' });
  const f = await bad.wait((await bad.call('explain', { area: 'x', cwd: h.repo })).run_id);
  assert.match(f.next, /^stop:/);
  const asks = await h.client({ STUB_QUESTION: '1' });
  const q = await asks.wait((await asks.call('explain', { area: 'x', cwd: h.repo })).run_id);
  assert.equal(q.status, 'waiting');
  assert.match(q.next, new RegExp(`^ask:.*resume\\("${q.id}"`));
  const ok = await k.wait((await k.call('explain', { area: 'x', cwd: h.repo })).run_id);
  assert.match(ok.next, /^auto:.*result_file/);
  h.tentacle('explain', null);
  await bad.close(); await asks.close();
});

test('review autonomy auto: an approved, verified branch merges at once; anything less previews', async () => {
  h.tentacle('review', { autonomy: 'auto' });
  const plan = await k.wait((await k.call('plan', { task: 'add a file', cwd: h.repo })).run_id);

  h.tentacle('execute', { verify: 'node -e "process.exit(0)"' });
  const e = await k.wait((await k.call('execute', { plan_id: plan.id })).run_id);
  const r = await k.wait((await k.call('review', { run_id: e.id })).run_id);
  assert.match(r.next, new RegExp(`^auto:.*merge\\("${e.id}"\\)`));
  const m = await k.call('merge', { run_id: e.id });
  assert.equal(m.outcome, 'merged');
  assert.equal(m.auto, true);
  assert.match(m.note, /review autonomy is auto/);

  h.tentacle('execute', null);
  const v = await k.wait((await k.call('execute', { plan_id: plan.id, verify: 'true' })).run_id);
  await k.wait((await k.call('review', { run_id: v.id })).run_id);
  const pv = await k.call('merge', { run_id: v.id });
  assert.equal(pv.preview, true);
  assert.match(pv.auto_merge_blocked_by.join(), /passed in the call/);
  await k.call('discard', { run_id: v.id });

  const n = await k.wait((await k.call('execute', { plan_id: plan.id })).run_id);
  await k.wait((await k.call('review', { run_id: n.id })).run_id);
  const pn = await k.call('merge', { run_id: n.id });
  assert.deepEqual(pn.auto_merge_blocked_by, ['it has no verify command (merging without a preview needs verified work)']);
  assert.equal((await k.call('discard', { run_id: n.id })).outcome, 'discarded', 'discard is unaffected');

  const c = await h.client({ STUB_VERDICT: 'changes_requested' });
  const x = await c.wait((await c.call('execute', { plan_id: plan.id })).run_id);
  const cr = await c.wait((await c.call('review', { run_id: x.id })).run_id);
  assert.match(cr.next, new RegExp(`^auto:.*resume\\("${x.id}"`));
  await c.call('discard', { run_id: x.id });
  await c.close();
  h.tentacle('review', null);
});
