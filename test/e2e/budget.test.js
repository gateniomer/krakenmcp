// End to end: max_cost_usd and max_tokens stop a run while it is running.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let h, k;
before(async () => { h = setup(); k = await h.client(); });
after(() => h.cleanup());

test('max_cost_usd and max_tokens stop a run as over_budget while it is running', async () => {
  h.tentacle('explain', { max_cost_usd: 0.5 });
  const pricey = await h.client({ STUB_COST: '1', STUB_SLEEP: '20' });
  const started = Date.now();
  const r = await pricey.call('explain', { area: 'expensive', cwd: h.repo });
  assert.deepEqual(r.limits, { max_cost_usd: 0.5 });
  const s = await pricey.wait(r.run_id);
  assert.equal(s.status, 'over_budget');
  assert.match(s.next, /report this error to the developer/);
  assert.match(s.stopped, /passed max_cost_usd \$0\.5/);
  assert.ok(Date.now() - started < 15_000, 'stopped long before the agent would have finished');
  assert.ok(s.metrics.cost_usd >= 1);

  h.tentacle('explain', { max_tokens: 500 });
  const cheap = await h.client({ STUB_COST: '0.0001', STUB_SLEEP: '20' });
  const t = await cheap.wait((await cheap.call('explain', { area: 'wordy', cwd: h.repo })).run_id);
  assert.equal(t.status, 'over_budget');
  assert.match(t.next, /report this error to the developer/);
  assert.match(t.stopped, /tokens passed max_tokens 500/);
  h.tentacle('explain', null);
  assert.equal((await k.call('session', {})).groups.find((g) => g.group.startsWith('explain')).failed, 2);
  await pricey.close(); await cheap.close();
});
