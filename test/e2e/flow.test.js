// End to end: the feature flow and how runs end (done, verify_failed, failed, timeout, in place).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, commitsOn } from './helpers.js';

let h, k;
before(async () => { h = setup(); k = await h.client({ STUB_FILE: 'feature.js' }); });
after(() => h.cleanup());

test('server exposes the documented tools, instructions and icons', async () => {
  const tools = (await k.c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['cancel', 'discard', 'execute', 'explain', 'merge',
    'pipeline', 'plan', 'resume', 'review', 'run', 'session', 'status', 'tentacles', 'think', 'update']);
  assert.match(k.c.getInstructions(), /only after\s+they explicitly approve/);
  const info = k.c.getServerVersion();
  assert.equal(info.name, 'kraken');
  assert.deepEqual(info.icons.map((i) => i.mimeType), ['image/png', 'image/svg+xml']);
});

let planRun, execRun;
test('think -> plan with context -> execute -> review -> merge lands the change', async () => {
  const think = await k.wait((await k.call('think', { problem: 'how should feature.js work?', cwd: h.repo })).run_id);
  assert.equal(think.status, 'done');
  assert.equal(think.access, 'read');

  planRun = await k.wait((await k.call('plan', { task: 'add feature.js', context_runs: [think.id] })).run_id);
  assert.equal(planRun.status, 'done');
  assert.ok(h.row(planRun.id).prompt.includes(`--- CONTEXT: think run ${think.id}`), 'plan prompt carries the think result');
  assert.equal(planRun.workdir, h.repo, 'repo is taken from the context run');

  execRun = await k.wait((await k.call('execute', { plan_id: planRun.id, verify: 'echo verify-ok' })).run_id);
  assert.equal(execRun.status, 'done');
  assert.match(execRun.branch, /^kraken\/execute_/);
  assert.equal(commitsOn(h, execRun.branch), 1);
  assert.equal(execRun.verify.exit, 0);
  assert.deepEqual(execRun.metrics.diff, { files: 1, insertions: 1, deletions: 0 });
  assert.equal(existsSync(join(h.repo, 'feature.js')), false, 'main checkout untouched before merge');

  const review = await k.wait((await k.call('review', { run_id: execRun.id })).run_id);
  assert.equal(review.verdict, 'approve');
  assert.equal(review.workdir, execRun.workdir, 'reviewer reads the changed files in the worktree');
  const reviewPrompt = h.row(review.id).prompt;
  assert.ok(reviewPrompt.includes('--- DIFF ---') && reviewPrompt.includes('+export const v'));
  assert.ok(reviewPrompt.includes(`CONTEXT: plan run ${planRun.id}`), 'review includes the plan');

  const preview = await k.call('merge', { run_id: execRun.id });
  assert.equal(preview.preview, true);
  assert.equal(preview.into, 'main');
  assert.equal(preview.commits.length, 1);
  assert.equal(preview.review.verdict, 'approve');
  assert.deepEqual(preview.warnings, []);
  assert.equal((await k.raw('merge', { run_id: execRun.id, confirm: 'not-the-token' })).isError, true);

  const merged = await k.call('merge', { run_id: execRun.id, confirm: preview.confirm_token });
  assert.equal(merged.outcome, 'merged');
  assert.ok(readFileSync(join(h.repo, 'feature.js'), 'utf8').includes('export const v'), 'the change is in main');
  assert.equal(h.git('branch', '--list', execRun.branch), '', 'branch deleted');
  assert.equal(existsSync(execRun.workdir), false, 'worktree removed');
  assert.match((await k.raw('merge', { run_id: execRun.id })).text, /already merged/);
});

test('review of uncommitted changes, and refusal when there is nothing to review', async () => {
  writeFileSync(join(h.repo, 'math.js'), 'export const one = 2;\n');
  const r = await k.wait((await k.call('review', { cwd: h.repo })).run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.workdir, h.repo);
  assert.equal(r.target_run, undefined);
  assert.ok(h.row(r.id).prompt.includes('-export const one = 1;'));
  h.git('checkout', '-q', 'math.js');
  assert.match((await k.raw('review', { cwd: h.repo })).text, /no uncommitted changes/);
});

test('a failing verify ends as verify_failed but keeps the work committed for review', async () => {
  const r = await k.wait((await k.call('execute', { plan_id: planRun.id, verify: 'echo boom; exit 3' })).run_id);
  assert.equal(r.status, 'verify_failed');
  assert.equal(r.verify.exit, 3);
  assert.match(r.verify.output, /boom/);
  assert.equal(commitsOn(h, r.branch), 1);
  await k.call('discard', { run_id: r.id });
});

test('an agent that exits non-zero ends as failed with its stderr', async () => {
  const bad = await h.client({ STUB_EXIT: '3' });
  const r = await bad.wait((await bad.call('explain', { area: 'x', cwd: h.repo })).run_id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /exit 3: stub failure/);
  await bad.close();
});

test('an agent error reported on stdout (e.g. provider unreachable) becomes the run error', async () => {
  const bad = await h.client({ STUB_PROVIDER_ERROR: '1' });
  const r = await bad.wait((await bad.call('explain', { area: 'x', cwd: h.repo })).run_id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /^exit 1: provider\.transport: ECONNREFUSED/);
  await bad.close();
});

test('a run over its timeout is stopped and ends as timeout', async () => {
  h.cli('set', 'slowpoke', 'prompt=Look at {{task}}', 'timeout_min=0.01');
  const slow = await h.client({ STUB_SLEEP: '20' });
  const started = Date.now();
  const r = await slow.wait((await slow.call('run', { tentacle: 'slowpoke', input: 'x', cwd: h.repo })).run_id);
  assert.equal(r.status, 'timeout');
  assert.ok(Date.now() - started < 10_000, 'stopped well before the agent would have finished');
  await slow.close();
});

test('isolation none edits the checkout in place; merge and discard refuse such runs', async () => {
  const r = await k.wait((await k.call('execute', { plan_id: planRun.id, isolation: 'none' })).run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.branch, undefined);
  assert.equal(r.workdir, h.repo);
  assert.deepEqual(r.metrics.diff, { files: 1, insertions: 1, deletions: 0, untracked_files: 0 }, 'edited the tracked feature.js');
  assert.match((await k.raw('merge', { run_id: r.id })).text, /in place/);
  assert.match((await k.raw('discard', { run_id: r.id })).text, /in place/);
  h.git('checkout', '-q', '.'); h.git('clean', '-qfd');
});

test('explain is read-only and runs in place without a branch', async () => {
  const r = await k.wait((await k.call('explain', { area: 'the math module', cwd: h.repo })).run_id);
  assert.equal(r.status, 'done');
  assert.equal(r.access, 'read');
  assert.equal(r.branch, undefined);
  assert.ok(h.argsLog().at(-1).includes('--agent plan'), 'read tentacles use the agent\'s read-only mode');
});

test('session totals and history reflect the outcomes above', async () => {
  const s = await k.call('session', {});
  const g = (prefix) => s.groups.find((x) => x.group.startsWith(prefix));
  assert.equal(g('execute').runs, 3);
  assert.equal(g('execute').merged, 1);
  assert.equal(g('execute').discarded, 1);
  assert.equal(g('execute').verify_failed, 1);
  assert.equal(g('explain').failed, 2, 'stderr failure + provider error');
  assert.equal(g('slowpoke').timeout, 1);
  assert.ok(s.total.tokens.cache_read > 0);
  assert.equal(s.runs.length, s.total.runs);
  assert.deepEqual(s.attention, { in_progress: [], waiting: [], ready_to_merge: [] }, 'everything above was merged or discarded');
});
