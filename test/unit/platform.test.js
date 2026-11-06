// Unit tests for platform.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which, alive, killTree, runShell, ancestors } from '../../src/platform.js';

test('alive, killTree and runShell behave on this OS', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(0), false);
  assert.equal(alive(-1), false);
  assert.equal(killTree(0), false, 'never signals pid 0 / process groups of the caller');
  const r = runShell('echo hello', { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hello/);
  const dir = mkdtempSync(join(tmpdir(), 'kraken-which-'));
  writeFileSync(join(dir, 'tool'), '#!/bin/sh\n'); chmodSync(join(dir, 'tool'), 0o755);
  assert.equal(which('tool', dir), join(dir, 'tool'));
  assert.equal(which('missing', dir), null);
});

test('ancestors walks up to the init process without loops', () => {
  const chain = ancestors();
  assert.ok(chain.length >= 1);
  assert.equal(chain[0], process.ppid);
  assert.equal(new Set(chain).size, chain.length);
});
