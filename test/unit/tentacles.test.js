// Unit tests for tentacle settings: tentacle files, layering, validation, prompt rendering.
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

// Write (or with text null, remove) a tentacle file in the developer's data dir.
const file = (name, text) => {
  const dir = T.userDir(); mkdirSync(dir, { recursive: true });
  if (text === null) rmSync(join(dir, `${name}.md`), { force: true }); else writeFileSync(join(dir, `${name}.md`), text);
};

test('built-ins resolve with sources', () => {
  const t = T.resolveTentacle('think', repo);
  assert.equal(t.settings.access, 'read');
  assert.equal(t.settings.agent, 'claude');
  assert.equal(t.sources.agent, 'built-in');
  assert.equal(t.builtin, true);
});

test('layers: user file beats built-in, call beats user file', () => {
  file('plan', '---\neffort: medium\n---\n');
  assert.equal(T.resolveTentacle('plan', repo).settings.effort, 'medium');
  assert.equal(T.resolveTentacle('plan', repo).sources.effort, 'user file');
  assert.equal(T.resolveTentacle('plan', repo, { effort: 'high' }).settings.effort, 'high');
  file('plan', null);
});

test('changing the agent resets model and effort to that agent\'s defaults', () => {
  const t = T.resolveTentacle('think', repo, { agent: 'opencode' });
  assert.equal(t.settings.agent, 'opencode');
  assert.equal(t.settings.model, null);
  assert.equal(t.settings.effort, null);
  assert.match(t.sources.model, /agent changed/);
});

test('validation rejects unknown fields and bad values', () => {
  assert.throws(() => T.parseTentacleFile('---\ncolour: red\n---\n'), /Unknown field/);
  assert.throws(() => T.parseTentacleFile('---\naccess: admin\n---\n'), /access must be one of/);
  assert.throws(() => T.parseTentacleFile('---\ntimeout_min: 999\n---\n'), /timeout_min/);
  assert.throws(() => T.resolveTentacle('think', repo, { effort: 5 }), /effort must be/);
  assert.throws(() => T.resolveTentacle('nope', repo), /Unknown tentacle/);
});

test('custom tentacles need a prompt', () => {
  file('audit', '---\naccess: read\n---\n');
  assert.throws(() => T.resolveTentacle('audit', repo), /has no prompt/);
  file('audit', '---\naccess: read\n---\nAudit {{task}}\n');
  const t = T.resolveTentacle('audit', repo);
  assert.equal(t.builtin, false);
  assert.equal(t.settings.access, 'read');
  assert.ok(T.knownNames(repo).includes('audit'));
  file('audit', null);
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
  assert.deepEqual(Object.keys(T.BUILTIN).sort(), ['execute', 'explain', 'plan', 'research', 'review', 'think']);
  assert.equal(T.BUILTIN.execute.access, 'write');
  assert.equal(T.BUILTIN.execute.max_tokens, null, 'fields a file leaves out get the defaults');
  assert.match(T.BUILTIN.review.prompt, /^You are the REVIEWER[\s\S]*\{\{diff\}\}$/);
});

test('a user tentacle file can override only some fields; bad file names are reported', () => {
  const dir = T.userDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.md'), '---\neffort: low\n---\n');
  writeFileSync(join(dir, 'Bad Name.md'), '---\n---\nx');
  const t = T.resolveTentacle('plan', repo);
  assert.equal(t.settings.effort, 'low');
  assert.equal(t.sources.effort, 'user file');
  assert.equal(t.sources.prompt, 'built-in', 'a file can override only some fields');
  assert.match(T.userTentacles().problems[0], /file name must be/);
  rmSync(dir, { recursive: true });
});

test('autonomy: defaults to ask, a user file or chain layer sets it, a call cannot', () => {
  assert.deepEqual([T.resolveTentacle('think', repo).autonomy, T.resolveTentacle('think', repo).sources.autonomy], ['ask', 'built-in']);
  file('lint', '---\ndescription: lint\n---\nLint {{task}}');
  assert.deepEqual([T.resolveTentacle('lint', repo).autonomy, T.resolveTentacle('lint', repo).sources.autonomy], ['ask', 'custom default']);
  file('plan', '---\nautonomy: auto\n---\n');
  const p = T.resolveTentacle('plan', repo);
  assert.deepEqual([p.autonomy, p.sources.autonomy], ['auto', 'user file']);
  const c = T.resolveTentacle('plan', repo, {}, [{ label: 'chain x', values: { autonomy: 'ask' } }]);
  assert.deepEqual([c.autonomy, c.sources.autonomy], ['ask', 'chain x']);
  assert.equal(T.resolveTentacle('think', repo, { autonomy: 'auto' }).autonomy, 'ask', 'a call never sets autonomy');
  assert.throws(() => T.resolveTentacle('think', repo, {}, [{ label: 'chain x', values: { autonomy: 'maybe' } }]), /autonomy must be one of ask, auto/);
  file('plan', null); file('lint', null);
  assert.match(T.tentacleTemplate('plan'), /# autonomy: ask/);
});

test('stageKind: review reads a diff, write works on a branch, everything else reads', () => {
  assert.equal(T.stageKind(T.resolveTentacle('review', repo)), 'review');
  assert.equal(T.stageKind(T.resolveTentacle('execute', repo)), 'write');
  assert.equal(T.stageKind(T.resolveTentacle('plan', repo)), 'read');
});
