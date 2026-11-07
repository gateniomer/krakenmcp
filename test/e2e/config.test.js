// End to end: settings (tentacle files) and how MCP sees them, the CLI, show, and prune.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { setup } from './helpers.js';

let h, k;
before(async () => { h = setup(); k = await h.client({}, 'config-client'); });
after(() => h.cleanup());

const json = (s) => JSON.parse(s);
const cliFails = (...a) => {
  try { h.cli(...a); return null; } catch (e) { return `${e.stdout}${e.stderr}`; }
};

test('cli: --version and version print the installed version', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
  assert.equal(h.cli('--version').trim(), pkg.version);
  assert.equal(h.cli('version').trim(), pkg.version);
});

test('cli: update refuses a source checkout instead of reinstalling globally', () => {
  // fakebin/npm makes a regression harmless: it never runs a real global install.
  assert.match(cliFails('update'), /local checkout|git pull|not installed under the npm global root/);
});

test('cli: update refuses an npm link and never runs npm install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraken-link-'));
  const log = join(dir, 'calls.log');
  symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), join(dir, 'krakenmcp'), 'dir');
  let text;
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../../src/bin.js', import.meta.url)), 'update'],
      { cwd: h.repo, encoding: 'utf8', env: { ...h.env, NPM_FAKE_ROOT: dir, NPM_CALL_LOG: log } });
  } catch (e) { text = `${e.stdout}${e.stderr}`; }
  assert.match(text ?? '', /linked or development install/);
  assert.equal(existsSync(log), false, 'npm install never ran');
  rmSync(dir, { recursive: true, force: true });
});

test('tentacles shows resolved settings with their sources, installed agents and limits', async () => {
  const t = await k.call('tentacles', { cwd: h.repo });
  assert.deepEqual(t.tentacles.map((x) => x.name), ['think', 'plan', 'execute', 'review', 'explain', 'research']);
  const think = t.tentacles.find((x) => x.name === 'think');
  assert.equal(think.settings.agent, 'opencode');
  assert.equal(think.sources.agent, 'user file');
  assert.equal(think.settings.effort, null, 'agent changed, so Claude-only effort was reset');
  assert.equal(t.agents.find((a) => a.name === 'opencode').installed, true);
  assert.deepEqual(t.limits, { max_parallel: 3 });
  assert.equal(t.chains[0].name, 'default');
  assert.deepEqual(t.chains[0].stages.map((s) => [s.tentacle, s.kind, s.autonomy]),
    [['plan', 'read', 'ask'], ['execute', 'write', 'ask'], ['review', 'review', 'ask']]);
  assert.equal(t.tentacles.find((x) => x.name === 'think').settings.autonomy, 'ask');
  assert.equal(t.tentacles.find((x) => x.name === 'think').sources.autonomy, 'built-in');
  assert.ok(t.tentacles.every((x) => x.settings.prompt.length <= 160), 'prompts are clipped unless asked for');
  const full = await k.call('tentacles', { cwd: h.repo, show_prompts: true });
  assert.match(full.tentacles[0].settings.prompt, /Open questions/);
});

test('krakenmcp mode is gone; chain list|edit|remove manage chain files', () => {
  assert.match(cliFails('mode', 'auto'), /usage: krakenmcp .*chain/);
  const listed = json(h.cli('chain', 'list'));
  assert.equal(listed.chains[0].name, 'default');
  assert.equal(listed.chains[0].stages[0].autonomy, 'ask (built-in)');
  const env = { ...h.env, VISUAL: 'true' };
  const cli = (...a) => execFileSync(process.execPath, [new URL('../../src/bin.js', import.meta.url).pathname, ...a],
    { encoding: 'utf8', env, cwd: h.repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const created = json(cli('chain', 'edit', 'stepwise'));
  assert.equal(created.created, true);
  assert.deepEqual(created.chain.stages.map((s) => s.tentacle), ['plan', 'execute', 'review']);
  writeFileSync(created.file, '---\nstages: [{"tentacle": "review"}, {"tentacle": "execute"}]\n---\n');
  let err;
  try { cli('chain', 'edit', 'stepwise'); } catch (e) { err = e; }
  assert.equal(err?.status, 1);
  assert.match(err.stdout, /must come after the write stage/);
  writeFileSync(created.file, '---\nstages: nope\n---\n');
  try { cli('chain', 'edit', 'stepwise'); err = null; } catch (e) { err = e; }
  assert.match(err?.stdout ?? '', /stages must be a JSON array/);
  assert.match(json(cli('chain', 'remove', 'stepwise')).note, /stepwise is gone/);
  assert.throws(() => cli('chain', 'remove', 'default'), /already the built-in/);
  assert.ok(json(h.cli('list')).every((t) => t.settings.autonomy === 'ask'));
});

test('tentacle files apply to MCP runs; MCP clients cannot store settings', async () => {
  h.tentacle('execute', { verify: 'npm test' });
  const execute = json(h.cli('list')).find((t) => t.name === 'execute');
  assert.equal(execute.settings.verify, 'npm test');
  assert.equal(execute.sources.verify, 'user file');

  h.tentacle('audit', { prompt: 'Audit {{task}} for secrets' });
  const audit = await k.wait((await k.call('run', { tentacle: 'audit', input: 'math.js', cwd: h.repo })).run_id);
  assert.equal(audit.status, 'done');
  assert.equal(audit.access, 'read');
  assert.ok(h.argsLog().at(-1).includes('Audit math.js for secrets'));

  const tools = (await k.c.listTools()).tools.map((t) => t.name);
  assert.ok(!tools.includes('configure_tentacle'), 'settings are the developer\'s');
  h.tentacle('execute', null); h.tentacle('audit', null);
});

test('CLI: list with typed file values, limit, and helpful errors', () => {
  h.tentacle('plan', { timeout_min: 5, model: null });
  const plan = json(h.cli('list')).find((t) => t.name === 'plan');
  assert.equal(plan.settings.timeout_min, 5, 'numbers are parsed');
  assert.equal(plan.sources.timeout_min, 'user file');
  h.tentacle('plan', null);
  assert.equal(json(h.cli('list')).find((t) => t.name === 'plan').sources.timeout_min, 'built-in');

  assert.deepEqual(json(h.cli('limit')), { max_parallel: 3 });
  assert.deepEqual(json(h.cli('limit', '2')), { max_parallel: 2 });
  h.cli('limit', '3');

  assert.match(cliFails('limit', '0'), /integer from 1 to 32/);
  assert.match(cliFails('frobnicate'), /usage: krakenmcp/);
});

test('krakenmcp edit creates a starter file, opens it in $VISUAL, and checks it', () => {
  const edit = (name, extra = {}) => spawnSync(process.execPath, [new URL('../../src/bin.js', import.meta.url).pathname, 'edit', name],
    { encoding: 'utf8', env: { ...h.env, VISUAL: 'true', ...extra }, cwd: h.repo });
  const file = join(h.env.KRAKEN_DATA, 'tentacles', 'explain.md');
  const r = edit('explain');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r.stdout).created, true);
  assert.match(readFileSync(file, 'utf8'), /^# agent: opencode$/m, 'built-in values, commented out');
  assert.equal(json(r.stdout).sources.prompt, 'built-in', 'no prompt in the file keeps the built-in one');

  const custom = edit('lint');
  assert.equal(json(custom.stdout).settings.access, 'read');
  assert.equal(json(custom.stdout).sources.prompt, 'user file');
  assert.ok(json(h.cli('list')).some((t) => t.name === 'lint'));

  writeFileSync(file, '---\ncolour: red\n---\n');
  const bad = edit('explain');
  assert.equal(bad.status, 1);
  assert.match(json(bad.stdout).problem, /Unknown field "colour"/);
  assert.match(edit('Bad Name').stderr, /usage: krakenmcp edit/);

  assert.match(h.cli('remove', 'explain'), /back to the built-in/);
  assert.ok(!existsSync(file));
  assert.match(cliFails('remove', 'explain'), /already the built-in/);
  assert.match(h.cli('remove', 'lint'), /lint is gone/);
  assert.ok(!json(h.cli('list')).some((t) => t.name === 'lint'));
  assert.match(cliFails('remove', 'nope'), /no tentacle nope/);
});

test('a run\'s full result is readable with krakenmcp show', async () => {
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
