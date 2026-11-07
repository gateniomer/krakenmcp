// Unit: project conventions: lines in src/ stay readable (no formatter dependency), and the update
// command points at this repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const MAX = 110;
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
  ? sources(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));

test(`every line in src/ is at most ${MAX} characters`, () => {
  const long = sources(SRC).flatMap((file) => readFileSync(file, 'utf8').split('\n')
    .map((line, i) => ({ file: file.slice(SRC.length), line: i + 1, length: [...line].length }))
    .filter((l) => l.length > MAX));
  assert.deepEqual(long, [], long.map((l) => `src/${l.file}:${l.line} is ${l.length} characters`).join('\n'));
});

test('krakenmcp update installs this repository with a valid npm git spec', async () => {
  process.env.KRAKEN_DATA ??= mkdtempSync(join(tmpdir(), 'kraken-spec-'));
  const { INSTALL_SPEC } = await import('../../src/store.js');
  const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));
  // github:<owner>/<repo>#<branch>; "@branch" makes npm read a version and resolve github.com/null/...
  const m = INSTALL_SPEC.match(/^github:([\w.-]+)\/([\w.-]+)#([\w./-]+)$/);
  assert.ok(m, `${INSTALL_SPEC} is not github:<owner>/<repo>#<branch>`);
  assert.ok(pkg.repository.url.includes(`github.com/${m[1]}/${m[2]}.git`), 'same repository as package.json');
});
