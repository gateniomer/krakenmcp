// Unit: code style the codebase keeps (no formatter dependency): lines in src/ stay readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
