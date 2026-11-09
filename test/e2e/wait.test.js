// End to end: `krakenmcp wait`, which a head runs in the background instead of polling status.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { setup } from './helpers.js';

const BIN = fileURLToPath(new URL('../../src/bin.js', import.meta.url));

let h, k, slow;
before(async () => {
  h = setup();
  k = await h.client();
  slow = await h.client({ STUB_SLEEP: '3' }, 'slow-client');
});
after(() => h.cleanup());

// Runs the CLI without blocking the test's event loop; resolves with exit code and parsed output.
const waitCli = (...a) => new Promise((resolve) => {
  const started = Date.now();
  execFile(process.execPath, [BIN, 'wait', ...a], { env: h.env, cwd: h.repo, encoding: 'utf8' },
    (err, stdout, stderr) => {
      let out = null;
      try { out = JSON.parse(stdout); } catch { /* error output */ }
      resolve({ code: err ? err.code : 0, out, stderr, ms: Date.now() - started });
    });
});

test('wait blocks until a busy run finishes, then reports its final status', async () => {
  const started = await slow.call('plan', { task: 'add a file', cwd: h.repo });
  assert.ok(['queued', 'running'].includes(h.row(started.run_id).status), 'the run is still busy');
  const r = await waitCli(started.run_id);
  assert.equal(r.code, 0);
  assert.equal(r.out.run_id, started.run_id);
  assert.equal(r.out.finished, true);
  assert.equal(r.out.status, h.row(started.run_id).status);
  assert.ok(!['queued', 'running'].includes(r.out.status));
  assert.match(r.out.next, /call status once/);
  assert.ok(r.ms >= 1500, `returned only after the run ended (${r.ms} ms)`);
});

test('wait returns at once for a finished run', async () => {
  const done = await k.wait((await k.call('plan', { task: 'another', cwd: h.repo })).run_id);
  const r = await waitCli(done.id);
  assert.equal(r.code, 0);
  assert.equal(r.out.status, 'done');
  assert.ok(r.ms < 5000);
});

test('wait stops at a question: a waiting run needs the head', async () => {
  const asker = await h.client({ STUB_QUESTION: '1' }, 'asker');
  const plan = await k.wait((await k.call('plan', { task: 'third', cwd: h.repo })).run_id);
  const started = await asker.call('execute', { plan_id: plan.id });
  const r = await waitCli(started.run_id);
  assert.equal(r.code, 0);
  assert.equal(r.out.status, 'waiting');
  await asker.close();
});

test('wait works for a chain and returns when it pauses for the developer', async () => {
  const c = await k.call('chain', { task: 'chain task', cwd: h.repo });
  const r = await waitCli(c.chain_id);
  assert.equal(r.code, 0);
  assert.equal(r.out.chain_id, c.chain_id);
  assert.ok(!['running', 'cancelling'].includes(r.out.status), `stopped as ${r.out.status}`);
  assert.equal(r.out.status, h.db().prepare('SELECT status FROM chains WHERE id = ?').get(c.chain_id).status);
  await k.call('cancel', { run_id: c.chain_id }).catch(() => {});
});

test('wait exits 2 on --timeout while the run is still busy', async () => {
  const started = await slow.call('plan', { task: 'slow one', cwd: h.repo });
  const r = await waitCli(started.run_id, '--timeout', '1');
  assert.equal(r.code, 2);
  assert.equal(r.out.finished, false);
  assert.match(r.out.next, /still (queued|running)/);
  await slow.wait(started.run_id);
});

test('wait rejects unknown ids, a missing id and a bad timeout', async () => {
  const missing = await waitCli('plan_doesnotexist');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no run plan_doesnotexist/);
  assert.match((await waitCli('chain_doesnotexist')).stderr, /no chain chain_doesnotexist/);
  assert.match((await waitCli()).stderr, /usage: krakenmcp wait/);
  assert.match((await waitCli('plan_x', '--timeout', 'soon')).stderr, /--timeout takes a number/);
});

test('the instructions tell the head to wait in the background instead of polling', () => {
  assert.match(k.c.getInstructions(), /krakenmcp wait <run_id>/);
  assert.match(k.c.getInstructions(), /counts against the developer's usage/);
});
