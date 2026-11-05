// End to end: settings (CLI) and how MCP sees them, the change log, about, show, and prune.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.js';

let h, k;
before(async () => { h = setup(); k = await h.client({}, 'config-client'); });
after(() => h.cleanup());

const json = (s) => JSON.parse(s);
const cliFails = (...a) => {
  try { h.cli(...a); return null; } catch (e) { return `${e.stdout}${e.stderr}`; }
};

test('tentacles shows resolved settings with their sources, installed agents and limits', async () => {
  const t = await k.call('tentacles', { cwd: h.repo });
  assert.deepEqual(t.tentacles.map((x) => x.name), ['think', 'plan', 'execute', 'review', 'explain']);
  const think = t.tentacles.find((x) => x.name === 'think');
  assert.equal(think.settings.agent, 'opencode');
  assert.equal(think.sources.agent, 'global');
  assert.equal(think.settings.effort, null, 'agent changed, so Claude-only effort was reset');
  assert.equal(t.agents.find((a) => a.name === 'opencode').installed, true);
  assert.deepEqual(t.limits, { max_parallel: 3, daily_budget_usd: null, spent_today_usd: 0, approval_mode: 'ask' });
  assert.ok(t.tentacles.every((x) => x.settings.prompt.length <= 160), 'prompts are clipped unless asked for');
  const full = await k.call('tentacles', { cwd: h.repo, show_prompts: true });
  assert.match(full.tentacles[0].settings.prompt, /Open questions/);
});

test('settings set with the CLI apply to MCP runs; MCP clients cannot store settings', async () => {
  const r = json(h.cli('set', 'execute', 'verify=npm test'));
  assert.equal(r.resolved.settings.verify, 'npm test');
  assert.equal(r.resolved.sources.verify, 'repo');

  h.cli('set', 'audit', 'prompt=Audit {{task}} for secrets');
  const audit = await k.wait((await k.call('run', { tentacle: 'audit', input: 'math.js', cwd: h.repo })).run_id);
  assert.equal(audit.status, 'done');
  assert.equal(audit.access, 'read');
  assert.ok(h.argsLog().at(-1).includes('Audit math.js for secrets'));

  const log = json(h.cli('log'));
  assert.equal(log[0].actor, 'cli:developer');
  assert.equal(log[0].name, 'audit');
  const tools = (await k.c.listTools()).tools.map((t) => t.name);
  assert.ok(!tools.includes('configure_tentacle') && !tools.includes('about'), 'settings and the about page are CLI-only');
  h.cli('reset', 'execute'); h.cli('reset', 'audit');
});

test('CLI: list, set with typed values, unset, reset, limit, and helpful errors', () => {
  h.cli('set', 'plan', 'timeout_min=5', 'model=null');
  const plan = json(h.cli('list')).find((t) => t.name === 'plan');
  assert.equal(plan.settings.timeout_min, 5, 'numbers are parsed');
  assert.equal(plan.sources.timeout_min, 'repo');
  h.cli('unset', 'plan', 'timeout_min');
  assert.equal(json(h.cli('list')).find((t) => t.name === 'plan').sources.timeout_min, 'built-in');
  h.cli('reset', 'plan');

  assert.deepEqual(json(h.cli('limit')), { max_parallel: 3 });
  assert.deepEqual(json(h.cli('limit', '2')), { max_parallel: 2 });
  h.cli('limit', '3');

  assert.match(cliFails('set', 'plan', 'novalue'), /expected key=value/);
  assert.match(cliFails('set', 'plan', 'colour=red'), /Unknown field/);
  assert.match(cliFails('limit', '0'), /integer from 1 to 32/);
  assert.match(cliFails('frobnicate'), /usage: krakenmcp/);
});

test('krakenmcp about shows the ASCII kraken with this repo\'s tentacles', () => {
  const cli = h.cli('about');
  assert.match(cli, /\(=O=\)/);
  assert.match(cli, /think\s+read\s+opencode/);
  assert.match(cli, /KrakenMCP v\d+\.\d+\.\d+/);
  assert.doesNotMatch(cli, /\x1b\[/, 'no colors when stdout is not a terminal');
});

test('a run\'s full result is readable with krakenmcp show and as a Markdown resource', async () => {
  const r = await k.wait((await k.call('plan', { task: 'show me', cwd: h.repo })).run_id);
  assert.match(r.result_file, /plans\/.+\.md$/);
  const shown = h.cli('show', r.id);
  assert.match(shown, new RegExp(`^# ${r.id}  plan  done`));
  assert.match(shown, /# task: show me/);
  assert.match(shown, /Done \(resumed=no\)\./);
  assert.equal(h.cli('show'), shown, 'without an id: the newest run with a result');
  assert.match(h.cli('show', r.id, '--log'), /"type":"text"/);
  const opened = spawnSync(process.execPath, [new URL('../../src/bin.js', import.meta.url).pathname, 'show', r.id, '--open'],
    { encoding: 'utf8', env: { ...h.env, VISUAL: 'ls' }, cwd: h.repo });
  assert.equal(opened.stdout.trim(), r.result_file, 'opens the result file in $VISUAL');
  assert.match(cliFails('show', 'nope'), /no run nope/);

  const res = await k.c.readResource({ uri: `kraken://result/${r.id}` });
  assert.equal(res.contents[0].mimeType, 'text/markdown');
  assert.match(res.contents[0].text, /Done \(resumed=no\)\./);
});

test('prune: dry run changes nothing; a real run clears old files and stale worktrees but keeps history', async () => {
  const r = await k.wait((await k.call('execute', { plan_id:
    (await k.wait((await k.call('plan', { task: 'x', cwd: h.repo })).run_id)).id })).run_id);
  const db = h.db();
  const runs = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;

  const dry = json(h.cli('prune', '--older-than', '0', '--dry-run', '--worktrees'));
  assert.ok(dry.files_removed > 0);
  assert.deepEqual(dry.worktrees_discarded, [r.branch]);
  assert.ok(existsSync(r.workdir), 'dry run kept the worktree');

  const real = json(h.cli('prune', '--older-than', '0', '--worktrees'));
  assert.equal(real.files_removed, dry.files_removed);
  assert.equal(existsSync(r.workdir), false);
  assert.equal(h.row(r.id).outcome, 'discarded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, runs, 'run history kept');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE prompt IS NOT NULL').get().n, 0);
  assert.ok(h.row(r.id).tokens, 'metrics kept');
  assert.equal(json(h.cli('prune', '--older-than', '0')).files_removed, 0);
  assert.match(cliFails('prune', '--older-than', 'soon'), /number of days/);
});

test('without --worktrees, prune only lists unmerged branches', async () => {
  const plan = await k.wait((await k.call('plan', { task: 'y', cwd: h.repo })).run_id);
  const r = await k.wait((await k.call('execute', { plan_id: plan.id })).run_id);
  const rep = json(h.cli('prune', '--older-than', '0'));
  assert.deepEqual(rep.unmerged_worktrees.map((u) => u.branch), [r.branch]);
  assert.ok(existsSync(r.workdir));
});

test('krakenmcp prints nothing on stderr (the SQLite experimental warning is filtered)', () => {
  const r = spawnSync(process.execPath, [new URL('../../src/bin.js', import.meta.url).pathname, 'limit'],
    { encoding: 'utf8', env: h.env });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { max_parallel: 3 });
  assert.equal(r.stderr, '');
});
