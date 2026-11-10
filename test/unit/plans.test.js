// Unit: plan files, sections and stages (src/plans.js) and review diff capping (src/diff.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickSection, splitStages, readPlanFile } from '../../src/plans.js';
import { capDiff } from '../../src/diff.js';

const PLAN = `# Step 7
Shared constraints.

## Part a: server
Intro to a.
### Stage 1: protocol
do p
\`\`\`md
## Stage 9: inside a code block, not a stage
\`\`\`
### Stage 2: shard
do s

## Part b: client
### Stage 3: ui
do u
`;

test('pickSection takes one heading up to the next heading of the same level', () => {
  const s = pickSection(PLAN, 'part A');
  assert.match(s.title, /^Part a: server$/);
  assert.match(s.section, /Stage 1: protocol[\s\S]*Stage 2: shard/);
  assert.doesNotMatch(s.section, /Part b|Stage 3/);
  assert.match(s.rest, /Shared constraints[\s\S]*Part b: client/);
  assert.equal(pickSection(PLAN, 'nope'), null);
});

test('splitStages finds Stage headings at one level and ignores code blocks', () => {
  assert.deepEqual(splitStages(pickSection(PLAN, 'part a').section).map((x) => x.title),
    ['Stage 1: protocol', 'Stage 2: shard']);
  assert.match(splitStages(PLAN)[1].body, /do s/);
  assert.equal(splitStages(PLAN).length, 3);
  assert.deepEqual(splitStages(pickSection(PLAN, 'part b').section), [], 'one stage is not a staged plan');
  assert.deepEqual(splitStages('# Plan\n## Goal\n## Risks\n'), []);
  assert.deepEqual(splitStages(undefined), []);
});

test('readPlanFile reads inside the repo only and labels the section', () => {
  const root = mkdtempSync(join(tmpdir(), 'kraken-plan-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'p.md'), PLAN);
  const all = readPlanFile(root, root, 'docs/p.md');
  assert.equal(all.label, 'docs/p.md');
  assert.equal(all.plan, PLAN.trim());
  const a = readPlanFile(root, join(root, 'docs'), 'p.md', 'Part b');
  assert.equal(a.label, 'docs/p.md § Part b: client');
  assert.match(a.plan, /^## Part b: client[\s\S]*REST OF docs\/p\.md \(context only: do NOT implement it\)/);
  assert.match(a.plan, /Shared constraints/);
  assert.equal(a.staged_text.includes('Part a'), false);
  assert.throws(() => readPlanFile(root, root, '../outside.md'), /inside the repository/);
  assert.throws(() => readPlanFile(root, root, 'docs/missing.md'), /not found/);
  assert.throws(() => readPlanFile(root, root, 'docs/p.md', 'Part z'), /no heading containing "Part z".*Part a/);
});

test('capDiff keeps whole files that fit and lists the rest with a command', () => {
  const file = (name, n) => `diff --git a/${name} b/${name}\n${'+x\n'.repeat(n)}`;
  const d = file('big.js', 100) + file('small.js', 2) + file('mid.js', 20);
  assert.equal(capDiff(d, 'abc', 10_000), d, 'under the limit: unchanged');
  const out = capDiff(d, 'abc', 150);
  assert.match(out, /diff --git a\/small\.js/);
  assert.match(out, /diff --git a\/mid\.js/);
  assert.doesNotMatch(out, /diff --git a\/big\.js/);
  assert.match(out, /1 of 3 changed files are not shown/);
  assert.match(out, /big\.js \(\d+ chars\): git diff abc -- big\.js/);
});
