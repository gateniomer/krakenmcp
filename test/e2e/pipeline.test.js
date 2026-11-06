// End to end: pipelines, budgets, progress notifications, and tentacle files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, sleep } from './helpers.js';

let h, k;
before(async () => { h = setup(); k = await h.client(); });
after(() => h.cleanup());

async function waitPipeline(c, id, { answer } = {}) {
  for (;;) {
    const s = await c.call('status', { run_id: id, wait_seconds: 20 });
    if (s.status === 'waiting' && answer) { await c.call('resume', { run_id: s.current.id, input: answer }); continue; }
    if (s.status !== 'running') return s;
  }
}

test('pipeline: plan -> execute -> review, stops before merge with the merge as the next step', async () => {
  const p = await k.call('pipeline', { task: 'add a feature file', cwd: h.repo, verify: 'node -e "process.exit(0)"' });
  assert.match(p.pipeline_id, /^pipe_/);
  const s = await waitPipeline(k, p.pipeline_id);
  assert.equal(s.status, 'done', s.error);
  assert.equal(s.result.verdict, 'approve');
  assert.ok(s.runs.plan && s.runs.execute && s.runs.review);
  assert.equal(h.row(s.runs.execute).plan_id, s.runs.plan);
  assert.equal(h.row(s.runs.review).target_run, s.runs.execute);
  assert.equal(h.row(s.runs.execute).pipeline_id, p.pipeline_id);
  assert.match(s.next, new RegExp(`merge\\("${s.runs.execute}"\\)`));
  assert.equal(h.row(s.runs.execute).outcome, null, 'nothing merged without the developer');
  const ses = await k.call('session', {});
  assert.ok(ses.pipelines.some((x) => x.id === p.pipeline_id));
  assert.deepEqual(ses.attention.ready_to_merge, [s.runs.execute], 'the pipeline\'s branch waits for the developer');
  await k.call('discard', { run_id: s.runs.execute });
});

test('approval mode auto: an approved, verified pipeline merges by itself; anything less still asks', async () => {
  assert.match(h.cli('mode', 'auto'), /"approval_mode": "auto"/);
  // A verify the head passes itself does not count: it could pass "true".
  const c = await waitPipeline(k, (await k.call('pipeline', { task: 'add a self-verified file', cwd: h.repo, verify: 'true' })).pipeline_id);
  assert.match(c.result.note, /not merged automatically: its verify command was passed in the call/);
  await k.call('discard', { run_id: c.runs.execute });

  h.tentacle('execute', { verify: 'node -e "process.exit(0)"' });
  const p = await k.call('pipeline', { task: 'add an auto file', cwd: h.repo });
  const s = await waitPipeline(k, p.pipeline_id);
  assert.match(s.result.note, /merged automatically as [0-9a-f]+/);
  assert.equal(h.row(s.runs.execute).outcome, 'merged');
  assert.equal(s.next, undefined, 'nothing left for the developer to approve');
  assert.match(h.git('log', '-1', '--format=%s'), new RegExp(`Merge kraken/${s.runs.execute}`));

  // No verify command: auto mode does not merge, and merge shows the preview with the reason.
  h.tentacle('execute', null);
  const q = await waitPipeline(k, (await k.call('pipeline', { task: 'add an unverified file', cwd: h.repo })).pipeline_id);
  assert.match(q.result.note, /not merged automatically: it has no verify command/);
  const preview = await k.call('merge', { run_id: q.runs.execute });
  assert.equal(preview.preview, true);
  assert.deepEqual(preview.auto_merge_blocked_by, ['it has no verify command (auto mode merges only verified work)']);
  await k.call('discard', { run_id: q.runs.execute });

  assert.match(h.cli('mode', 'ask'), /"approval_mode": "ask"/);
  assert.throws(() => h.cli('mode', 'yolo'), /"ask" or "auto"/);
});

test('pipeline: changes_requested triggers a fix round on the same branch, then a second review', async () => {
  const c = await h.client({ STUB_VERDICT: 'changes_requested' });
  const p = await c.call('pipeline', { task: 'fix me', cwd: h.repo, max_fix_rounds: 1 });
  const s = await waitPipeline(c, p.pipeline_id);
  assert.equal(s.status, 'done');
  assert.equal(s.result.verdict, 'changes_requested');
  assert.match(s.result.note, /after 1 fix round/);
  assert.equal(s.fix_rounds, '1 of 1');
  const fix = h.row(s.runs.execute);
  assert.ok(fix.resumed_from, 'the fix resumed the executor');
  assert.match(fix.prompt, /requested changes[\s\S]*\[major\] math\.js:1/);
  assert.equal(h.row(s.runs.review).target_run, fix.id, 'the second review looked at the fixed branch');
  await c.call('discard', { run_id: fix.id });
  await c.close();
});

test('pipeline: a failing verify gets a fix round with the verify output', async () => {
  const p = await k.call('pipeline', { task: 'verify fails', cwd: h.repo, verify: 'node -e "console.log(\'boom\');process.exit(3)"' });
  const s = await waitPipeline(k, p.pipeline_id);
  assert.equal(s.status, 'done');
  assert.equal(s.fix_rounds, '1 of 1');
  assert.match(h.row(s.runs.execute).prompt, /failed \(exit 3\)[\s\S]*boom/);
  await k.call('discard', { run_id: s.runs.execute });
});

test('pipeline: questions pause it as waiting; answering the run lets it continue by itself', async () => {
  const c = await h.client({ STUB_QUESTION: '1' });
  const p = await c.call('pipeline', { task: 'needs a decision', cwd: h.repo });
  let s;
  for (;;) { s = await c.call('status', { run_id: p.pipeline_id, wait_seconds: 20 }); if (s.status !== 'running') break; }
  assert.equal(s.status, 'waiting');
  assert.equal(s.stage, 'plan');
  assert.equal(s.question, 'Keep it in a separate file?');
  assert.match(s.next, /resume\(/);
  const done = await waitPipeline(c, p.pipeline_id, { answer: 'yes' });
  assert.equal(done.status, 'done', done.error);
  assert.ok(h.row(done.runs.plan).resumed_from, 'the plan the pipeline used is the answered one');
  await c.call('discard', { run_id: done.runs.execute });
  await c.close();
});

test('pipeline: cancel stops the current step; a dead driver is marked failed', async () => {
  const slow = await h.client({ STUB_SLEEP: '20' });
  const p = await slow.call('pipeline', { task: 'slow', cwd: h.repo });
  let s;
  for (let i = 0; i < 50; i++) { s = await slow.call('status', { run_id: p.pipeline_id }); if (s.current?.status === 'running') break; await sleep(200); }
  assert.equal((await slow.call('cancel', { run_id: p.pipeline_id })).status, 'cancelling');
  s = await waitPipeline(slow, p.pipeline_id);
  assert.equal(s.status, 'cancelled');
  for (let i = 0; i < 50 && h.row(s.runs.plan).status !== 'cancelled'; i++) await sleep(200);
  assert.equal(h.row(s.runs.plan).status, 'cancelled');

  const p2 = await slow.call('pipeline', { task: 'driver dies', cwd: h.repo });
  await sleep(500);
  const pid = h.db().prepare('SELECT pid FROM pipelines WHERE id = ?').get(p2.pipeline_id).pid;
  process.kill(pid, 'SIGKILL');
  await sleep(300);
  const dead = await slow.call('status', { run_id: p2.pipeline_id });
  assert.equal(dead.status, 'failed');
  assert.match(dead.error, /driver exited unexpectedly/);
  assert.match(dead.next, /report this error to the developer/);
  if (dead.runs.plan) await slow.call('cancel', { run_id: dead.runs.plan });
  await slow.close();
});

test('max_cost_usd and max_tokens stop a run as over_budget while it is running', async () => {
  h.tentacle('explain', { max_cost_usd: 0.5 });
  const pricey = await h.client({ STUB_COST: '1', STUB_SLEEP: '20' });
  const started = Date.now();
  const r = await pricey.call('explain', { area: 'expensive', cwd: h.repo });
  assert.deepEqual(r.limits, { max_cost_usd: 0.5 });
  const s = await pricey.wait(r.run_id);
  assert.equal(s.status, 'over_budget');
  assert.match(s.next, /report this error to the developer/);
  assert.match(s.stopped, /passed max_cost_usd \$0\.5/);
  assert.ok(Date.now() - started < 15_000, 'stopped long before the agent would have finished');
  assert.ok(s.metrics.cost_usd >= 1);

  h.tentacle('explain', { max_tokens: 500 });
  const cheap = await h.client({ STUB_COST: '0.0001', STUB_SLEEP: '20' });
  const t = await cheap.wait((await cheap.call('explain', { area: 'wordy', cwd: h.repo })).run_id);
  assert.equal(t.status, 'over_budget');
  assert.match(t.next, /report this error to the developer/);
  assert.match(t.stopped, /tokens passed max_tokens 500/);
  h.tentacle('explain', null);
  assert.equal((await k.call('session', {})).groups.find((g) => g.group.startsWith('explain')).failed, 2);
  await pricey.close(); await cheap.close();
});

test('status sends progress notifications while it waits', async () => {
  const c = await h.client({ STUB_SLEEP: '3' });
  const { run_id } = await c.call('explain', { area: 'progress', cwd: h.repo });
  const progress = [];
  const r = await c.c.callTool({ name: 'status', arguments: { run_id, wait_seconds: 20 } }, undefined,
    { onprogress: (p) => progress.push(p), timeout: 60_000 });
  assert.equal(JSON.parse(r.content[0].text).status, 'done');
  assert.ok(progress.length >= 1, 'got progress notifications');
  assert.match(progress[0].message, /explain tentacle \(opencode /);
  await c.close();
});

test('tentacle files in the developer\'s data dir add tentacles without any config command', async () => {
  const dir = join(h.env.KRAKEN_DATA, 'tentacles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'audit-deps.md'), '---\ndescription: Audit dependencies\nagent: opencode\n---\nAudit the dependencies of {{task}}\n');
  writeFileSync(join(dir, 'broken.md'), 'no header here');
  const t = await k.call('tentacles', { cwd: h.repo });
  const a = t.tentacles.find((x) => x.name === 'audit-deps');
  assert.equal(a.sources.prompt, 'user file');
  assert.match(t.user_files.problems[0], /broken\.md: expected a "---" settings header/);
  assert.ok(!t.tentacles.some((x) => x.name === 'broken'), 'a broken file is skipped, not fatal');
  const s = await k.wait((await k.call('run', { tentacle: 'audit-deps', input: 'package.json', cwd: h.repo })).run_id);
  assert.equal(s.status, 'done');
  assert.ok(h.argsLog().at(-1).includes('Audit the dependencies of package.json'));
});
