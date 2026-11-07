// Unit tests for chain files: parsing, layering over the built-in, and the checks that make a
// chain runnable.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'kraken-chains-'));
process.env.KRAKEN_DATA = join(tmp, 'data');
const repo = join(tmp, 'repo');
mkdirSync(repo);

let C;
before(async () => { C = await import('../../src/chains.js'); });

const chainFile = (name, text) => {
  const dir = C.userChainDir(); mkdirSync(dir, { recursive: true });
  if (text === null) rmSync(join(dir, `${name}.md`), { force: true }); else writeFileSync(join(dir, `${name}.md`), text);
};
const tentacleFile = (name, text) => {
  const dir = join(process.env.KRAKEN_DATA, 'tentacles'); mkdirSync(dir, { recursive: true });
  if (text === null) rmSync(join(dir, `${name}.md`), { force: true }); else writeFileSync(join(dir, `${name}.md`), text);
};
const stages = (s) => `---\nstages: ${JSON.stringify(s)}\n---\n`;
const check = (s) => C.checkChain({ name: 't', stages: s }, repo).problems.join('\n');

test('the built-in default chain: plan -> execute -> review, one fix round, no stage autonomy', () => {
  const c = C.resolveChain();
  assert.deepEqual(c.stages, [{ tentacle: 'plan' }, { tentacle: 'execute' }, { tentacle: 'review' }]);
  assert.equal(c.max_fix_rounds, 1);
  assert.equal(c.builtin, true);
  assert.match(c.notes, /never sent to agents/);
  const k = C.checkChain(c, repo);
  assert.deepEqual(k.problems, []);
  assert.equal(k.has_write, true);
  assert.deepEqual(k.stages.map((s) => [s.kind, s.autonomy, s.autonomy_source]),
    [['read', 'ask', 'built-in'], ['write', 'ask', 'built-in'], ['review', 'ask', 'built-in']]);
  assert.deepEqual(C.knownChains(), ['default']);
});

test('a user default.md overrides only what it sets', () => {
  chainFile('default', '---\nmax_fix_rounds: 2\n---\n');
  const c = C.resolveChain('default');
  assert.equal(c.max_fix_rounds, 2);
  assert.deepEqual([c.sources.max_fix_rounds, c.sources.stages], ['user file', 'built-in']);
  assert.ok(c.user_file.endsWith('default.md'));
  chainFile('default', null);
});

test('structural errors in a chain file', () => {
  const bad = [
    ['---\nstages: {"tentacle": "plan"}\n---\n', /must be a JSON array/],
    ['---\nstages: []\n---\n', /1 to 8 entries/],
    [stages(Array(9).fill({ tentacle: 'plan' })), /1 to 8 entries/],
    [stages(['plan']), /must be an object/],
    [stages([{ agent: 'opencode' }]), /tentacle must be a tentacle name/],
    [stages([{ tentacle: 'Plan!' }]), /tentacle must be a tentacle name/],
    [stages([{ tentacle: 'plan', prompt: 'x' }]), /unknown key "prompt"/],
    [stages([{ tentacle: 'plan', agent: 'gpt' }]), /stage 1: agent must be one of/],
    [stages([{ tentacle: 'plan', autonomy: 'yes' }]), /autonomy must be one of ask, auto/],
    ['---\nstagez: []\n---\n', /Unknown field "stagez"/],
    ['---\nmax_fix_rounds: 9\n---\n', /integer from 0 to 5/],
    ['---\ndescription: 3\n---\n', /description must be a string/],
    ['no header', /settings header/],
  ];
  for (const [text, err] of bad) assert.throws(() => C.parseChainFile(text), err, text);
});

test('semantic checks: tentacles exist, one write stage after its plan, reviews after it, verify on write only', () => {
  assert.match(check([{ tentacle: 'nope' }]), /stage 1 \(nope\): Unknown tentacle/);
  assert.match(check([{ tentacle: 'plan' }, { tentacle: 'execute' }, { tentacle: 'execute' }]), /only one write stage/);
  assert.match(check([{ tentacle: 'plan' }, { tentacle: 'review' }, { tentacle: 'execute' }]), /must come after the write stage/);
  assert.match(check([{ tentacle: 'execute' }]), /needs a plan/);
  assert.match(check([{ tentacle: 'plan', verify: 'npm test' }]), /verify is only for the write stage/);
  assert.equal(check([{ tentacle: 'explain' }, { tentacle: 'plan' }]), '');
});

test('stage autonomy beats the tentacle file, which beats the default', () => {
  tentacleFile('plan', '---\nautonomy: auto\n---\n');
  const k = C.checkChain({ name: 'x', stages: [{ tentacle: 'plan' }, { tentacle: 'explain', autonomy: 'auto' }, { tentacle: 'think' }] }, repo);
  assert.deepEqual(k.stages.map((s) => [s.autonomy, s.autonomy_source]),
    [['auto', 'user file'], ['auto', 'chain x'], ['ask', 'built-in']]);
  assert.deepEqual(k.stages[1].layer, { autonomy: 'auto' });
  tentacleFile('plan', null);
});

test('user chains: notes stay out of the stages, a broken file is reported but not fatal', () => {
  chainFile('look', '---\ndescription: look\nstages: [{"tentacle": "explain"}]\n---\nmy notes\n');
  chainFile('broken', '---\nstages: nope\n---\n');
  chainFile('Bad Name', stages([{ tentacle: 'plan' }]));
  assert.deepEqual(C.knownChains(), ['default', 'look']);
  const look = C.resolveChain('look');
  assert.deepEqual(look.stages, [{ tentacle: 'explain' }]);
  assert.equal(look.notes, 'my notes');
  const problems = C.userChains().problems.join('\n');
  assert.match(problems, /broken\.md: stages must be a JSON array/);
  assert.match(problems, /Bad Name\.md: file name must be/);
  assert.throws(() => C.resolveChain('nope'), /Unknown chain "nope"; known: default, look/);
  chainFile('nostages', '---\ndescription: empty\n---\n');
  assert.throws(() => C.resolveChain('nostages'), /has no stages/);
  for (const n of ['look', 'broken', 'Bad Name', 'nostages']) chainFile(n, null);
});

test('chainTemplate: a new chain is runnable; the built-in one parses', () => {
  const fresh = C.parseChainFile(C.chainTemplate('mine'));
  assert.deepEqual(C.checkChain({ name: 'mine', stages: fresh.stages }, repo).problems, []);
  const b = C.parseChainFile(C.chainTemplate('default'));
  assert.equal(b.stages, undefined, 'every built-in field is commented out');
});
