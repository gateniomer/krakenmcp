// Unit tests for the about page and the stderr warning filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KRAKEN_DATA = mkdtempSync(join(tmpdir(), 'kraken-about-'));
const { aboutText, VERSION } = await import('../../src/about.js');

test('about: plain text has the kraken and live tentacles; color mode adds ANSI only around art and headings', () => {
  const plain = aboutText({ cwd: tmpdir() });
  assert.match(plain, new RegExp(`KrakenMCP v${VERSION.replace(/\./g, '\\.')}`));
  assert.match(plain, /\(=O=\)/);
  for (const t of ['think', 'plan', 'execute', 'review', 'explain']) assert.match(plain, new RegExp(`^  ${t}\\s`, 'm'));
  assert.doesNotMatch(plain, /\x1b\[/);
  const color = aboutText({ cwd: tmpdir(), color: true });
  assert.match(color, /\x1b\[31m@/, 'red tentacle tips');
  assert.match(color, /\x1b\[33mO/, 'amber eyes');
  assert.equal(color.replace(/\x1b\[[0-9;]*m/g, ''), plain, 'same content, only colors added');
});

test('quiet: drops only the SQLite experimental warning', async () => {
  const { isSqliteExperimental } = await import('../../src/quiet.js');
  assert.equal(isSqliteExperimental('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning'), true);
  assert.equal(isSqliteExperimental(Object.assign(new Error('SQLite is experimental'), { name: 'ExperimentalWarning' })), true);
  assert.equal(isSqliteExperimental('SQLite is experimental', { type: 'ExperimentalWarning' }), true);
  assert.equal(isSqliteExperimental('Fetch is experimental', 'ExperimentalWarning'), false);
  assert.equal(isSqliteExperimental('sqlite in a deprecation', 'DeprecationWarning'), false);

  const seen = [];
  const onWarning = (w) => seen.push(w.message);
  process.on('warning', onWarning);
  process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning'); // installed filter drops it
  await new Promise((r) => setImmediate(r));
  process.off('warning', onWarning);
  assert.deepEqual(seen, []);
});
