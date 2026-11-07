// End to end: update (sync a run's branch with the developer's branch), conflict prediction and
// resolution, and recovery from things going wrong around a run (deleted worktree, killed agent,
// an old database).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setup, sleep } from './helpers.js';

let h, k, planId;
before(async () => {
  h = setup();
  k = await h.client();
  planId = (await k.wait((await k.call('plan', { task: 'add a file', cwd: h.repo })).run_id)).id;
});
after(() => h.cleanup());

const wtGit = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: h.env }).trim();
const mergeHead = (dir) => { try { wtGit(dir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'); return true; } catch { return false; } };
// A change on main that conflicts with a run that edits math.js.
function conflictOnMain(n) {
  writeFileSync(join(h.repo, 'math.js'), `export const one = ${n};\n`);
  h.git('commit', '-qam', `main changes math.js to ${n}`);
}

test('update merges a moved main into a clean branch and moves its base; merge then lands both', async () => {
  const r = await k.wait((await k.call('execute', { plan_id: planId })).run_id);
  writeFileSync(join(h.repo, 'other.js'), 'export const other = 1;\n');
  h.git('add', '.'); h.git('commit', '-qm', 'unrelated change on main');
  const preview = await k.call('merge', { run_id: r.id });
  assert.deepEqual(preview.conflicts, [], 'merge-tree predicts a clean merge');

  const u = await k.call('update', { run_id: r.id });
  assert.equal(u.updated, true);
  assert.equal(h.row(r.id).base_sha, h.git('rev-parse', 'HEAD'), 'base moved to the merged main');
  assert.ok(existsSync(join(r.workdir, 'other.js')), 'main\'s change is in the worktree');
  assert.match((await k.call('update', { run_id: r.id })).note, /already contains/);

  const review = await k.wait((await k.call('review', { run_id: r.id })).run_id);
  assert.equal(review.status, 'done');
  const p2 = await k.call('merge', { run_id: r.id });
  assert.equal(p2.warnings.length, 0, JSON.stringify(p2.warnings));
  assert.equal((await k.call('merge', { run_id: r.id, confirm: p2.confirm_token })).outcome, 'merged');
});

test('merge preview predicts conflicts; update resumes the agent to resolve them and Kraken finishes the merge', async () => {
  const c = await h.client({ STUB_FILE: 'math.js', STUB_RESOLVE: '1' });
  const r = await c.wait((await c.call('execute', { plan_id: planId })).run_id);
  conflictOnMain(100);

  const preview = await c.call('merge', { run_id: r.id });
  assert.deepEqual(preview.conflicts, ['math.js']);
  assert.ok(preview.warnings.some((w) => /update\(run_id\)/.test(w)));
  const failed = await c.raw('merge', { run_id: r.id, confirm: preview.confirm_token });
  assert.match(failed.text, /Call update\(run_id\)/);

  const u = await c.call('update', { run_id: r.id });
  assert.equal(u.updated, 'resolving');
  assert.deepEqual(u.conflicts, ['math.js']);
  assert.equal(u.resumes, r.id);
  const fix = await c.wait(u.run_id);
  assert.match(h.argsLog().at(-1), /--session ses_stub1[\s\S]*conflicts in: - math\.js Resolve every conflict/);
  assert.equal(fix.status, 'done', fix.error);
  assert.equal(mergeHead(r.workdir), false, 'the merge was concluded by Kraken\'s commit');
  assert.equal(h.row(r.id).base_sha, h.git('rev-parse', 'HEAD'), 'base moved for every run on the branch');

  const p2 = await c.call('merge', { run_id: fix.id });
  assert.deepEqual(p2.conflicts, []);
  assert.equal((await c.call('merge', { run_id: fix.id, confirm: p2.confirm_token })).outcome, 'merged');
  assert.equal(h.row(r.id).outcome, 'merged', 'the original run shares the branch outcome');
  await c.close();
});

test('update with resolve false only lists the conflicts and leaves the worktree as it was', async () => {
  const c = await h.client({ STUB_FILE: 'math.js' });
  const r = await c.wait((await c.call('execute', { plan_id: planId })).run_id);
  conflictOnMain(200);
  const u = await c.call('update', { run_id: r.id, resolve: false });
  assert.deepEqual([u.updated, u.conflicts], [false, ['math.js']]);
  assert.equal(mergeHead(r.workdir), false);
  assert.equal(wtGit(r.workdir, 'status', '--porcelain'), '');
  await c.call('discard', { run_id: r.id });
  await c.close();
});

test('a resolution that leaves conflict markers fails and is not committed', async () => {
  const c = await h.client({ STUB_FILE: 'math.js' }); // no STUB_RESOLVE: the stub just appends a line
  const r = await c.wait((await c.call('execute', { plan_id: planId })).run_id);
  conflictOnMain(300);
  const u = await c.call('update', { run_id: r.id });
  const fix = await c.wait(u.run_id);
  assert.equal(fix.status, 'failed');
  assert.match(fix.error, /conflict markers are still in: math\.js/);
  assert.equal(mergeHead(r.workdir), true, 'the merge is still open for another attempt');
  assert.match((await c.raw('update', { run_id: r.id })).text, /merge is already in progress/);
  assert.match((await c.raw('resume', { run_id: r.id, input: 'x' })).text, /merge is in progress/);
  await c.call('discard', { run_id: r.id });
  await c.close();
});

test('a worktree deleted by hand comes back from its branch on resume and review', async () => {
  const r = await k.wait((await k.call('execute', { plan_id: planId })).run_id);
  rmSync(r.workdir, { recursive: true, force: true });
  const rev = await k.wait((await k.call('review', { run_id: r.id })).run_id);
  assert.equal(rev.status, 'done');
  assert.ok(existsSync(r.workdir));
  rmSync(r.workdir, { recursive: true, force: true });
  const res = await k.wait((await k.call('resume', { run_id: r.id, input: 'one more file' })).run_id);
  assert.equal(res.status, 'done');
  assert.ok(res.recent_messages.length > 0);
  assert.ok(h.git('log', '--oneline', `main..${r.branch}`).split('\n').length >= 2, 'old and new work on the branch');
  await k.call('discard', { run_id: r.id });
});

test('an agent killed from outside ends the run as failed, not stuck running', async () => {
  const slow = await h.client({ STUB_SLEEP: '20' });
  const { run_id } = await slow.call('explain', { area: 'killed', cwd: h.repo });
  let row;
  for (let i = 0; i < 50 && !(row = h.row(run_id))?.agent_pid; i++) await sleep(100);
  await sleep(300);
  process.kill(row.agent_pid, 'SIGKILL');
  const s = await slow.wait(run_id);
  assert.equal(s.status, 'failed');
  assert.match(s.error, /exit null/);
  await slow.close();
});

test('a database from an older version gets the new columns on first use', () => {
  const data = mkdtempSync(join(tmpdir(), 'kraken-olddb-'));
  const first = { ...h.env, KRAKEN_DATA: data };
  execFileSync(process.execPath, [new URL('../../src/bin.js', import.meta.url).pathname, 'limit'], { env: first });
  const db = new DatabaseSync(join(data, 'kraken.db'));
  for (const c of ['cancel_requested', 'stop_reason', 'chain_id', 'chain_stage']) db.exec(`ALTER TABLE runs DROP COLUMN ${c}`);
  db.close();
  execFileSync(process.execPath, [new URL('../../src/bin.js', import.meta.url).pathname, 'limit'], { env: first });
  const again = new DatabaseSync(join(data, 'kraken.db'));
  const cols = again.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
  again.close();
  for (const c of ['cancel_requested', 'stop_reason', 'chain_id', 'chain_stage']) assert.ok(cols.includes(c), c);
  rmSync(data, { recursive: true, force: true });
});
