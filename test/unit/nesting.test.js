// Unit tests for nested-run detection (a Kraken server started inside a Kraken run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KRAKEN_DATA = mkdtempSync(join(tmpdir(), 'kraken-nest-'));
delete process.env.KRAKEN_PARENT_RUN;
const { nestedRun, ancestors } = await import('../../src/nesting.js');
const { insertRun, updateRun } = await import('../../src/store.js');

insertRun({ id: 'run_a', session: 's', tentacle: 'plan', access: 'read', task: 't', agent: 'opencode', prompt: 'p',
  cwd: '/r', workdir: '/r' });

test('the environment marker wins', () => {
  assert.equal(nestedRun({ env: { KRAKEN_PARENT_RUN: 'run_x' }, chain: [] }), 'run_x');
});

test('an ancestor that is a running run\'s agent or worker marks the process as nested', () => {
  updateRun('run_a', { status: 'running', agent_pid: 4242, pid: 4141 });
  assert.equal(nestedRun({ env: {}, chain: [9, 4242, 7] }), 'run_a');
  assert.equal(nestedRun({ env: {}, chain: [4141] }), 'run_a');
  assert.equal(nestedRun({ env: {}, chain: [9, 7] }), null);
});

test('finished runs do not count, so a reused pid cannot disable Kraken', () => {
  updateRun('run_a', { status: 'done' });
  assert.equal(nestedRun({ env: {}, chain: [4242] }), null);
});

test('ancestors walks up to the real parent process', () => {
  const chain = ancestors();
  assert.equal(chain[0], process.ppid);
  assert.ok(chain.every((p) => Number.isInteger(p) && p > 1));
});
