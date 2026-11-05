// Unit tests for platform.js. The Windows branches are exercised with `windows: true` on any OS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { which, windowsExts, shimTarget, spawnTarget, alive, killTree, runShell, ancestors, IS_WINDOWS } from '../../src/platform.js';

test('windowsExts puts .exe first and keeps PATHEXT order otherwise', () => {
  assert.deepEqual(windowsExts('.COM;.BAT;.CMD;.EXE'), ['.exe', '.com', '.bat', '.cmd']);
  assert.deepEqual(windowsExts(undefined)[0], '.exe');
});

test('which on Windows tries extensions and prefers a native .exe over a .cmd shim', () => {
  const a = mkdtempSync(join(tmpdir(), 'kraken-win-a-'));
  const b = mkdtempSync(join(tmpdir(), 'kraken-win-b-'));
  writeFileSync(join(a, 'agent.cmd'), '@echo off');
  writeFileSync(join(a, 'agent.exe'), '');
  writeFileSync(join(b, 'other.cmd'), '@echo off');
  assert.equal(which('agent', `${a};${b}`, { windows: true, pathext: '.CMD;.EXE' }), join(a, 'agent.exe'));
  assert.equal(which('other', `${a};${b}`, { windows: true, pathext: '.CMD;.EXE' }), join(b, 'other.cmd'));
  assert.equal(which('missing', `${a};${b}`, { windows: true }), null);
});

test('npm .cmd shims are run as node <script>, so multi-line prompts survive', () => {
  const npmShim = '@ECHO off\r\nGOTO start\r\n:start\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const target = shimTarget('C:/npm/claude.cmd', () => npmShim);
  assert.equal(target, resolve('C:/npm', 'node_modules/@anthropic-ai/claude-code/cli.js'));
  assert.equal(shimTarget('C:/x/stub.cmd', () => 'node "%~dp0\\stub.mjs" %*'), resolve('C:/x', 'stub.mjs'));
  const t = spawnTarget('C:/npm/claude.cmd', ['-p', 'line 1\nline 2'], { windows: true, read: () => npmShim });
  assert.equal(t.command, process.execPath);
  assert.deepEqual(t.args.slice(1), ['-p', 'line 1\nline 2']);
  assert.throws(() => spawnTarget('C:/x/odd.bat', [], { windows: true, read: () => 'echo hi' }), /native \.exe/);
  assert.deepEqual(spawnTarget('/usr/bin/opencode', ['a']), { command: '/usr/bin/opencode', args: ['a'] });
  assert.deepEqual(spawnTarget('C:/bin/codex.exe', ['a'], { windows: true }), { command: 'C:/bin/codex.exe', args: ['a'] });
});

test('alive, killTree and runShell behave on this OS', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(0), false);
  assert.equal(alive(-1), false);
  assert.equal(killTree(0), false, 'never signals pid 0 / process groups of the caller');
  const r = runShell('echo hello', { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hello/);
  if (!IS_WINDOWS) {
    const dir = mkdtempSync(join(tmpdir(), 'kraken-which-'));
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n'); chmodSync(join(dir, 'tool'), 0o755);
    assert.equal(which('tool', dir), join(dir, 'tool'));
  }
});

test('ancestors walks up to the init process without loops', () => {
  const chain = ancestors();
  assert.ok(chain.length >= 1);
  assert.equal(chain[0], process.ppid);
  assert.equal(new Set(chain).size, chain.length);
});
