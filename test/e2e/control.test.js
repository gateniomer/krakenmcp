// End to end: control tools (discard, resume, answer, cancel, merge guards), scheduling and recovery.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, commitsOn, sleep } from './helpers.js';

let h, k, planId;
before(async () => {
  h = setup();
  k = await h.client();
  planId = (await k.wait((await k.call('plan', { task: 'add a file', cwd: h.repo })).run_id)).id;
});
after(() => h.cleanup());

test('discard deletes the branch and worktree; the run cannot be resumed or merged afterwards', async () => {
  const r = await k.wait((await k.call('execute', { plan_id: planId })).run_id);
  const d = await k.call('discard', { run_id: r.id });
  assert.equal(d.outcome, 'discarded');
  assert.equal(h.git('branch', '--list', r.branch), '');
  assert.equal(existsSync(r.workdir), false);
  assert.match((await k.raw('resume', { run_id: r.id, input: 'more' })).text, /already discarded/);
  assert.match((await k.raw('merge', { run_id: r.id })).text, /already discarded/);
});

test('resume continues the same agent session on the same branch', async () => {
  const r = await k.wait((await k.call('execute', { plan_id: planId })).run_id);
  const r2 = await k.wait((await k.call('resume', { run_id: r.id, input: 'also add a second file' })).run_id);
  assert.equal(r2.status, 'done');
  assert.equal(r2.resumed_from, r.id);
  assert.equal(r2.branch, r.branch);
  assert.ok(h.argsLog().at(-1).includes('--session ses_stub1'), 'agent was resumed, not restarted');
  assert.ok(h.argsLog().at(-1).includes('also add a second file'));
  assert.equal(commitsOn(h, r.branch), 2);
  // discarding the original also closes the resumed run that shares its branch
  await k.call('discard', { run_id: r.id });
  assert.equal(h.row(r2.id).outcome, 'discarded');
});

test('an agent question pauses the run; resume answers it with the developer\'s words', async () => {
  const asker = await h.client({ STUB_QUESTION: '1' });
  const q = await asker.wait((await asker.call('execute', { plan_id: planId })).run_id);
  assert.equal(q.status, 'waiting');
  assert.equal(q.question, 'Keep it in a separate file?');
  assert.match(q.next, /resume\(/);
  assert.deepEqual((await asker.call('session', {})).attention.waiting, [q.id]);
  assert.equal(commitsOn(h, q.branch), 0, 'nothing is committed while waiting');

  const resumed = await asker.call('resume', { run_id: q.id, input: 'Yes, a separate file' });
  assert.match(resumed.next, /since 0/, 'answering keeps the live feed going');
  const done = await asker.wait(resumed.run_id);
  assert.equal(done.status, 'done');
  assert.ok(h.argsLog().at(-1).includes('ANSWER: Yes, a separate file'));
  assert.equal((await asker.call('status', { run_id: q.id })).status, 'answered');
  assert.equal(commitsOn(h, q.branch), 1);
  // On a finished run the same tool is a plain follow-up, not an answer.
  await asker.wait((await asker.call('resume', { run_id: done.id, input: 'Also add a comment' })).run_id);
  assert.ok(!h.argsLog().at(-1).includes('ANSWER:'));
  assert.ok(h.argsLog().at(-1).includes('Also add a comment'));
  await asker.close();
});

test('cancel stops a running agent; cancelling a finished run changes nothing', async () => {
  const slow = await h.client({ STUB_SLEEP: '30' });
  const { run_id } = await slow.call('explain', { area: 'slow', cwd: h.repo });
  for (let i = 0; i < 50 && h.row(run_id).status !== 'running'; i++) await sleep(100);
  const agentPid = h.row(run_id).agent_pid;
  const c = await slow.call('cancel', { run_id });
  assert.equal(c.status, 'cancelling');
  const started = Date.now();
  const r = await slow.wait(run_id);
  assert.equal(r.status, 'cancelled');
  assert.ok(Date.now() - started < 5000);
  assert.throws(() => process.kill(agentPid, 0), 'agent process is gone');
  assert.equal((await slow.call('cancel', { run_id })).changed, false);
  await slow.close();
});

test('with limit 1 a second run waits its turn, and a queued run can be cancelled before it starts', async () => {
  h.cli('limit', '1');
  const slow = await h.client({ STUB_SLEEP: '2' });
  const a = await slow.call('explain', { area: 'first', cwd: h.repo });
  const b = await slow.call('explain', { area: 'second', cwd: h.repo });
  const c = await slow.call('explain', { area: 'third', cwd: h.repo });
  assert.equal(b.status, 'queued');
  assert.deepEqual(b.queue, { waiting_for_slot: true, ahead: 0, max_parallel: 1 });
  assert.equal(c.queue.ahead, 1);

  const cancelled = await slow.call('cancel', { run_id: c.run_id });
  assert.equal(cancelled.status, 'cancelled');
  const ra = await slow.wait(a.run_id); const rb = await slow.wait(b.run_id);
  assert.equal(ra.status, 'done'); assert.equal(rb.status, 'done');
  assert.ok(h.row(b.run_id).started_at >= h.row(a.run_id).finished_at, 'second started after the first finished');
  assert.equal(h.row(c.run_id).started_at, null, 'cancelled run never started');
  assert.equal(h.argsLog().filter((l) => l.includes('AREA: third')).length, 0);
  h.cli('limit', '3');
  await slow.close();
});

test('a run whose worker died is marked failed and its agent stopped', async () => {
  const slow = await h.client({ STUB_SLEEP: '30' });
  const { run_id } = await slow.call('explain', { area: 'crash', cwd: h.repo });
  for (let i = 0; i < 50 && !(h.row(run_id).status === 'running' && h.row(run_id).pid > 0); i++) await sleep(100);
  const { pid, agent_pid } = h.row(run_id);
  process.kill(pid, 'SIGKILL');
  await sleep(300);
  const r = await slow.call('status', { run_id });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /exited unexpectedly/);
  await sleep(300);
  assert.throws(() => process.kill(agent_pid, 0), 'orphaned agent stopped');
  await slow.close();
});

test('cancelling a run whose worker already died records it and stops the orphaned agent', async () => {
  const slow = await h.client({ STUB_SLEEP: '30' });
  const { run_id } = await slow.call('explain', { area: 'orphan', cwd: h.repo });
  for (let i = 0; i < 50 && !(h.row(run_id).status === 'running' && h.row(run_id).pid > 0); i++) await sleep(100);
  const { pid, agent_pid } = h.row(run_id);
  process.kill(pid, 'SIGKILL');
  await sleep(200);
  const c = await slow.call('cancel', { run_id }); // cancel does not reap first, so this hits the dead-worker path
  assert.deepEqual([c.status, c.note], ['cancelled', 'worker was not running']);
  await sleep(300);
  assert.throws(() => process.kill(agent_pid, 0), 'orphaned agent stopped');
  assert.equal(h.row(run_id).status, 'cancelled');
  await slow.close();
});

test('merge refuses a dirty checkout, and aborts cleanly on a conflict keeping the branch', async () => {
  const conflicting = await h.client({ STUB_FILE: 'math.js' });
  const r = await conflicting.wait((await conflicting.call('execute', { plan_id: planId })).run_id);
  const preview = await conflicting.call('merge', { run_id: r.id });

  writeFileSync(join(h.repo, 'math.js'), 'export const one = 100;\n');
  assert.match((await conflicting.raw('merge', { run_id: r.id, confirm: preview.confirm_token })).text, /uncommitted changes/);
  h.git('commit', '-qam', 'conflicting change on main');

  const res = await conflicting.raw('merge', { run_id: r.id, confirm: preview.confirm_token });
  assert.equal(res.isError, true);
  assert.match(res.text, /merge failed and was aborted; the branch is kept[\s\S]*math\.js/);
  assert.equal(h.git('status', '--porcelain'), '', 'main checkout left clean');
  assert.notEqual(h.git('branch', '--list', r.branch), '', 'branch kept');
  assert.equal(h.row(r.id).outcome, null);
  await conflicting.call('discard', { run_id: r.id });
  await conflicting.close();
});

test('inputs are validated: unknown or unfinished runs, missing plans, wrong tentacles', async () => {
  assert.match((await k.raw('plan', { task: 'x', cwd: h.repo, context_runs: ['nope'] })).text, /no run with id nope/);
  assert.match((await k.raw('execute', { plan_id: 'nope' })).text, /no run with id nope/);
  assert.match((await k.raw('run', { tentacle: 'execute', input: 'x', cwd: h.repo })).text, /needs plan_id/);
  assert.match((await k.raw('run', { tentacle: 'nope', input: 'x', cwd: h.repo })).text, /Unknown tentacle "nope"/);
  assert.match((await k.raw('run', { tentacle: 'plan', input: 'x', cwd: '/definitely/missing' })).text, /cwd does not exist/);
  assert.match((await k.raw('review', { run_id: planId })).text, /is a read run/);
  assert.match((await k.raw('status', { run_id: 'nope' })).text, /no run nope/);
  const slow = await h.client({ STUB_SLEEP: '5' });
  const { run_id } = await slow.call('explain', { area: 'busy', cwd: h.repo });
  assert.match((await slow.raw('plan', { task: 'x', context_runs: [run_id] })).text, /must be done with a result/);
  await slow.call('cancel', { run_id });
  await slow.close();
});
