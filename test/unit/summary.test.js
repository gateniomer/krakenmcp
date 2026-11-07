// Unit: the live summary helpers (pure formatting, no runs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kraken-summary-'));
process.env.KRAKEN_DATA = dir; // store.js opens its DB when runs.js is imported
const m = await import('../../src/feed.js');
after(() => rmSync(dir, { recursive: true, force: true }));

test('elapsedText: seconds, minutes, unknown', () => {
  assert.equal(m.elapsedText(undefined), '—');
  assert.equal(m.elapsedText(42000), '42s');
  assert.equal(m.elapsedText(125000), '2m 05s');
  assert.equal(m.elapsedText(725000), '12m 05s');
});

test('headline: columns stay apart for long statuses and long times', () => {
  const tools = { total: 6, by_name: { read: 6 } };
  assert.match(m.headline('plan › claude opus', 'running', 42000, tools, 'using read'),
    /● running  42s    6 tools   using read$/);
  assert.match(m.headline('plan › claude opus', 'verify_failed', 42000, tools, 'x'),
    /✕ verify_failed 42s/);
  assert.match(m.headline('plan › claude opus', 'cancelled', 42000, tools, 'x'),
    /⊘ cancelled 42s/);
  assert.match(m.headline('plan › claude opus', 'running', 725000, tools, 'x'),
    /12m 05s 6 tools/);
  assert.match(m.headline('p', 'queued', undefined, { total: 0 }, 'queued'),
    /○ queued.*—.*—.*queued/);
});

test('toolCounts counts every tool line; currentActivity reads the newest one', () => {
  assert.deepEqual(m.toolCounts([{ body: 'tool: read' }, { body: 'tool: read' }]),
    { total: 2, by_name: { read: 2 } });
  assert.equal(m.currentActivity([{ kind: 'progress', sender: 'x', body: 'tool: grep' }], 'running'), 'using grep');
  assert.equal(m.currentActivity([], 'queued'), 'queued');
  assert.equal(m.currentActivity([{ kind: 'progress', sender: 'claude', body: 'a sentence' }], 'running'), 'a sentence');
  assert.equal(m.currentActivity([], 'waiting'), 'question for the developer');
});

test('lastAgentText skips tool lines and Kraken lifecycle messages', () => {
  const rows = [
    { kind: 'progress', sender: 'claude', body: 'tool: read' },
    { kind: 'progress', sender: 'kraken', body: 'started plan' },
    { kind: 'progress', sender: 'claude', body: 'hello' },
  ];
  assert.equal(m.lastAgentText(rows), 'hello');
  assert.equal(m.lastAgentText([{ kind: 'progress', sender: 'kraken', body: 'started' }]), undefined);
});
