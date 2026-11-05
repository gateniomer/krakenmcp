// Unit tests for tentacle settings: layering, validation, tentacle files, prompt rendering.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'kraken-unit-'));
process.env.KRAKEN_DATA = join(tmp, 'data');
const repo = join(tmp, 'repo');
mkdirSync(repo);

let T;
before(async () => { T = await import('../../src/tentacles.js'); });

const cfg = (args) => T.configureTentacle({ cwd: repo, actor: 'test', ...args });

test('built-ins resolve with sources', () => {
  const t = T.resolveTentacle('think', repo);
  assert.equal(t.settings.access, 'read');
  assert.equal(t.settings.agent, 'claude');
  assert.equal(t.sources.agent, 'built-in');
  assert.equal(t.builtin, true);
});

test('layers: repo beats global, call beats repo', () => {
  cfg({ name: 'plan', scope: 'global', set: { effort: 'low' } });
  cfg({ name: 'plan', scope: 'repo', set: { effort: 'medium' } });
  assert.equal(T.resolveTentacle('plan', repo).settings.effort, 'medium');
  assert.equal(T.resolveTentacle('plan', repo).sources.effort, 'repo');
  assert.equal(T.resolveTentacle('plan', repo, { effort: 'high' }).settings.effort, 'high');
  cfg({ name: 'plan', scope: 'repo', reset: true });
  cfg({ name: 'plan', scope: 'global', reset: true });
});

test('changing the agent resets model and effort to that agent\'s defaults', () => {
  const t = T.resolveTentacle('think', repo, { agent: 'opencode' });
  assert.equal(t.settings.agent, 'opencode');
  assert.equal(t.settings.model, null);
  assert.equal(t.settings.effort, null);
  assert.match(t.sources.model, /agent changed/);
});

test('read access forces isolation none', () => {
  cfg({ name: 'explain', set: { isolation: 'worktree' } });
  const t = T.resolveTentacle('explain', repo);
  assert.equal(t.settings.isolation, 'none');
  assert.equal(t.sources.isolation, 'forced (read access)');
  cfg({ name: 'explain', reset: true });
});

test('validation rejects unknown fields and bad values', () => {
  assert.throws(() => cfg({ name: 'plan', set: { colour: 'red' } }), /Unknown field/);
  assert.throws(() => cfg({ name: 'plan', set: { access: 'admin' } }), /access must be one of/);
  assert.throws(() => cfg({ name: 'plan', set: { timeout_min: 999 } }), /timeout_min/);
  assert.throws(() => cfg({ name: 'plan', set: { reuse_session_min: 500 } }), /reuse_session_min/);
  assert.throws(() => cfg({ name: 'Bad Name', set: {} }), /name must be/);
  assert.throws(() => T.resolveTentacle('nope', repo), /Unknown tentacle/);
});

test('custom tentacles need a prompt', () => {
  assert.throws(() => cfg({ name: 'audit', set: { access: 'read' } }), /needs a prompt/);
  cfg({ name: 'audit', set: { prompt: 'Audit {{task}}' } });
  const t = T.resolveTentacle('audit', repo);
  assert.equal(t.builtin, false);
  assert.equal(t.settings.access, 'read');
  assert.ok(T.knownNames(repo).includes('audit'));
});

test('needs_plan / needs_diff come from the prompt placeholders', () => {
  assert.equal(T.resolveTentacle('execute', repo).needs_plan, true);
  assert.equal(T.resolveTentacle('review', repo).needs_diff, true);
  assert.equal(T.resolveTentacle('plan', repo).needs_plan, false);
});

test('renderPrompt: fixed preamble, placeholders, appended context', () => {
  const read = T.resolveTentacle('plan', repo);
  const p = T.renderPrompt(read, { task: 'Add X', context: 'CTX-BLOCK' });
  assert.match(p, /^You have READ-ONLY access/);
  assert.match(p, /KRAKEN_QUESTION/);
  assert.match(p, /TASK: Add X/);
  assert.ok(p.trimEnd().endsWith('CTX-BLOCK'), 'context is appended when the template has no {{context}}');

  const write = T.resolveTentacle('execute', repo);
  const w = T.renderPrompt(write, { plan: 'THE PLAN', workdir: '/w/1' });
  assert.match(w, /Your working directory is \/w\/1/);
  assert.match(w, /THE PLAN/);
});

test('formatContext labels each run', () => {
  const s = T.formatContext([{ id: 'think_1', tentacle: 'think', agent: 'claude', model: 'opus', result: 'R1' }]);
  assert.match(s, /--- CONTEXT: think run think_1 \(claude opus\) ---\nR1/);
  assert.equal(T.formatContext([]), '');
});

test('tentacle files: header values are typed, the body is the prompt, bad files are rejected', () => {
  const t = T.parseTentacleFile('---\ndescription: Audit: deps\naccess: write\ntimeout_min: 5\nmodel: null\n# a comment\n---\nAudit {{task}}\n');
  assert.deepEqual(t, { description: 'Audit: deps', access: 'write', timeout_min: 5, model: null, prompt: 'Audit {{task}}' });
  assert.throws(() => T.parseTentacleFile('Audit {{task}}'), /settings header/);
  assert.throws(() => T.parseTentacleFile('---\nnot a pair\n---\nx'), /bad header line/);
  assert.throws(() => T.parseTentacleFile('---\naccess: admin\n---\nx'), /access must be one of/);
  assert.throws(() => T.parseTentacleFile('---\nprompt: x\n---\n'), /goes after the header/);
});

test('built-in tentacles are loaded from src/tentacles/*.md', () => {
  assert.deepEqual(Object.keys(T.BUILTIN).sort(), ['execute', 'explain', 'plan', 'review', 'think']);
  assert.equal(T.BUILTIN.execute.access, 'write');
  assert.equal(T.BUILTIN.execute.max_tokens, null, 'fields a file leaves out get the defaults');
  assert.match(T.BUILTIN.review.prompt, /^You are the REVIEWER[\s\S]*\{\{diff\}\}$/);
});

test('a user tentacle file sits between built-ins and global settings', () => {
  const dir = T.userDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.md'), '---\neffort: low\n---\n');
  writeFileSync(join(dir, 'Bad Name.md'), '---\n---\nx');
  let t = T.resolveTentacle('plan', repo);
  assert.equal(t.settings.effort, 'low');
  assert.equal(t.sources.effort, 'user file');
  assert.equal(t.sources.prompt, 'built-in', 'a file can override only some fields');
  assert.match(T.userTentacles().problems[0], /file name must be/);
  cfg({ name: 'plan', scope: 'global', set: { effort: 'high' } });
  t = T.resolveTentacle('plan', repo);
  assert.equal(t.sources.effort, 'global');
  cfg({ name: 'plan', scope: 'global', reset: true });
  rmSync(dir, { recursive: true });
});
