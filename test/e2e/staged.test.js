// End to end: execute from a plan file, staged runs (one agent session per stage, a commit after
// each, stage checks, resume continuing the stages left), worktree setup, and WIP commits on stop.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, commitsOn } from './helpers.js';

let h, k;
before(async () => {
  h = setup();
  mkdirSync(join(h.repo, 'docs'));
  writeFileSync(join(h.repo, 'docs', 'step.md'), [
    '# Step 9', 'Shared rules.', '',
    '## Part a', '### Stage 1: first', 'do one', '### Stage 2: second', 'do two', '',
    '## Part b', 'single-stage part', ''].join('\n'));
  writeFileSync(join(h.repo, '.gitignore'), 'checks.log\nchecks.ok\n');
  h.git('add', '.'); h.git('commit', '-qm', 'plan');
  k = await h.client();
});
after(() => h.cleanup());

const subjects = (branch) => h.git('log', '--format=%s', `main..${branch}`).split('\n').filter(Boolean).reverse();
const freshInvocations = () => h.argsLog().filter((l) => / run /.test(l) && !l.includes('--session'));

test('execute(plan_file, section) runs each stage in a fresh session and commits after each', async () => {
  const before = h.argsLog().length;
  const start = await k.call('execute', { plan_file: 'docs/step.md', section: 'part a', cwd: h.repo,
    stage_verify: 'echo stage >> checks.log', verify: 'echo final >> checks.log' });
  assert.deepEqual(start.stages, ['Stage 1: first', 'Stage 2: second']);
  assert.equal(start.plan_file, 'docs/step.md § Part a');
  const r = await k.wait(start.run_id);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.stages, { done: 2, total: 2 });
  assert.equal(r.task, 'Implement docs/step.md § Part a');
  assert.deepEqual(subjects(r.branch).map((s) => s.split(':')[0]),
    ['kraken(stage 1/opencode)', 'kraken(execute/opencode)']);
  const calls = h.argsLog().slice(before);
  assert.equal(calls.length, 2, 'one agent process per stage');
  assert.ok(calls.every((l) => !l.includes('--session')), 'every stage is a fresh session');
  assert.match(calls[0], /Do ONLY stage 1 of 2: "Stage 1: first"/);
  assert.match(calls[1], /Do ONLY stage 2 of 2: "Stage 2: second"/);
  assert.match(calls[0], /REST OF docs\/step\.md \(context only/);
  assert.match(calls[0], /Shared rules/);
  const prompt = h.row(r.id).prompt;
  assert.doesNotMatch(prompt, /STAGED RUN/, 'the stored prompt is the base, stages are added per segment');
  assert.equal(readFileSync(join(r.workdir, 'checks.log'), 'utf8'), 'stage\nfinal\n',
    'stage check after stage 1 only, the full verify once at the end');
  assert.match(r.result, /## Stage 1\/2: Stage 1: first[\s\S]*## Stage 2\/2: Stage 2: second/);
  assert.equal(r.metrics.diff.files, 2, 'diff stat covers every stage');
});

test('a single-stage section runs as one plain segment; plan_id and plan_file are exclusive', async () => {
  const r = await k.wait((await k.call('execute', { plan_file: 'docs/step.md', section: 'Part b', cwd: h.repo })).run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.stages, undefined);
  assert.equal(commitsOn(h, r.branch), 1);
  assert.match((await k.raw('execute', { cwd: h.repo })).text, /pass plan_id or plan_file/);
  assert.match((await k.raw('execute', { plan_id: 'x', plan_file: 'docs/step.md', cwd: h.repo })).text,
    /not both/);
  assert.match((await k.raw('execute', { plan_file: 'docs/step.md', section: 'zzz', cwd: h.repo })).text,
    /no heading containing "zzz"/);
});

test('a failing stage check stops the run; resume finishes that stage and runs the rest', async () => {
  const r = await k.wait((await k.call('execute', { plan_file: 'docs/step.md', section: 'part a', cwd: h.repo,
    stage_verify: 'test -f checks.ok || (touch checks.ok; exit 3)' })).run_id);
  assert.equal(r.status, 'verify_failed');
  assert.deepEqual(r.stages, { done: 0, total: 2, current: 'Stage 1: first' });
  assert.match(r.verify.output, /stage 1 check failed: test -f checks\.ok/);
  assert.equal(r.verify.exit, 3);
  assert.equal(commitsOn(h, r.branch), 1, 'stage 1 work is committed even though its check failed');

  const before = h.argsLog().length;
  const res = await k.wait((await k.call('resume', { run_id: r.id, input: 'fix the failing check' })).run_id);
  assert.equal(res.status, 'done');
  assert.deepEqual(res.stages, { done: 2, total: 2 });
  const calls = h.argsLog().slice(before);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('--session'), 'first the old session finishes stage 1');
  assert.ok(!calls[1].includes('--session') && /Do ONLY stage 2 of 2/.test(calls[1]), 'then stage 2, fresh');
  assert.equal(commitsOn(h, r.branch), 3);
});

test('setup runs once in the new worktree; a failing setup fails the run before the agent', async () => {
  h.tentacle('execute', { setup: '"touch setup-ran.txt"' });
  const before = freshInvocations().length;
  const ok = await k.wait((await k.call('execute', { plan_file: 'docs/step.md', section: 'Part b', cwd: h.repo })).run_id);
  assert.equal(ok.status, 'done');
  assert.ok(h.git('show', '--name-only', '--format=', ok.branch).includes('setup-ran.txt'),
    'setup ran in the worktree before the commit');
  h.tentacle('execute', { setup: '"exit 7"' });
  const bad = await k.wait((await k.call('execute', { plan_file: 'docs/step.md', section: 'Part b', cwd: h.repo })).run_id);
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /setup failed \(exit 7\)/);
  assert.equal(freshInvocations().length, before + 1, 'the agent never started for the failed setup');
  h.tentacle('execute', null);
});

test('a timed-out write run keeps its work as a WIP commit', async () => {
  h.tentacle('execute', { timeout_min: 0.03 });
  const t = await h.client({ STUB_SLEEP: '10' }, 'timeout-client');
  const r = await t.wait((await t.call('execute', { plan_file: 'docs/step.md', section: 'Part b', cwd: h.repo })).run_id);
  assert.equal(r.status, 'timeout');
  assert.deepEqual(subjects(r.branch).map((s) => s.split(':')[0]), ['kraken(wip timeout/opencode)']);
  h.tentacle('execute', null);
});
