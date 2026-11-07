#!/usr/bin/env node
// Developer CLI. Settings live in the developer's files (~/.kraken/tentacles/*.md and
// ~/.kraken/chains/*.md); MCP clients can read them, never change them.
//
//   krakenmcp list                          resolved tentacles for the repo [--cwd <repo>]
// krakenmcp edit <name>                   open ~/.kraken/tentacles/<name>.md (created if missing), then check
// it
// krakenmcp remove <name>                 delete that file: your tentacle is gone, a built-in is back to its
// defaults
//   krakenmcp chain list|edit <name>|remove <name>   the same for chains in ~/.kraken/chains/
// krakenmcp doctor                        check installed agent CLIs (exit 1 if a tentacle needs a missing
// one)
//   krakenmcp limit [n]                     show/set max parallel runs (default 3)
//   krakenmcp prune [--older-than 30] [--dry-run] [--worktrees]
//        delete logs/result files and stored prompts of runs finished more than N days ago; list
//        unmerged worktrees (--worktrees also discards the stale ones)
//   krakenmcp show [run_id] [--open|--log]  a run's full result (default: the newest run with one);
//        --open opens the result file in $VISUAL / $EDITOR, --log prints the raw agent output
//   krakenmcp update                        reinstall a global git install and print the old -> new version
//   krakenmcp --version                     print the installed version
import './quiet.js';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { knownNames, resolveTentacle, NAME, userDir, userTentacles, tentacleTemplate, BUILTIN }
  from './tentacles.js';
import { PLANS_DIR, LOGS_DIR, ROOT, VERSION, INSTALL_SPEC, db, getRun, setSetting } from './store.js';
import { maxParallel } from './scheduler.js';
import { knownChains, resolveChain, checkChain, userChainDir, userChains, chainTemplate, parseChainFile,
  BUILTIN_CHAINS } from './chains.js';
import { pruneData } from './prune.js';
import { checkAgents } from './agents.js';
import { agentReport } from './stats.js';
import { parseJson, fail } from './util.js';

const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (f) => {
  const i = argv.indexOf(f);
  if (i < 0) return null;
  const v = argv[i + 1]; argv.splice(i, 2); return v;
};

const openIt = flag('--open'), showLog = flag('--log');
const cwd = resolve(opt('--cwd') ?? process.cwd());
const [cmd, name, arg2] = argv;
const out = (o) => console.log(JSON.stringify(o, null, 2));
const editor = () => process.env.VISUAL || process.env.EDITOR;
const brief = (t) => ({ ...t.settings, prompt: `${t.settings.prompt.slice(0, 60)}…` });

function openInEditor(file) {
  const r = spawnSync(`${editor()} "${file}"`, { stdio: 'inherit', shell: true });
  if (r.error || r.status) fail(`the editor exited with an error${r.error ? `: ${r.error.message}` : ''}`);
}

// ---- the developer's settings files: tentacles and chains share edit and remove ----

function chainInfo(chainName) {
  const c = resolveChain(chainName), k = checkChain(c, cwd);
  return { name: chainName, builtin: c.builtin, description: c.description, user_file: c.user_file,
    max_fix_rounds: c.max_fix_rounds,
    stages: k.stages.map((s) => ({ tentacle: s.tentacle, kind: s.kind,
      autonomy: `${s.autonomy} (${s.autonomy_source})`,
      stage_settings: Object.keys(s.layer).length ? s.layer : undefined })),
    sources: c.sources, notes: c.notes, problems: k.problems.length ? k.problems : undefined };
}

// check(name, file) -> { problem } or the fields to print for a good file.
const FILES = {
  tentacle: {
    dir: userDir, template: tentacleTemplate, builtin: (n) => !!BUILTIN[n],
    reset: 'the built-in settings and prompt',
    check(n, file) {
      const problem = userTentacles().problems.find((p) => p.startsWith(file));
      if (problem) return { problem: problem.slice(file.length + 2) };
      const t = resolveTentacle(n, cwd);
      return { settings: brief(t), sources: t.sources };
    },
  },
  chain: {
    dir: userChainDir, template: chainTemplate, builtin: (n) => !!BUILTIN_CHAINS[n], reset: 'the built-in',
    check(n, file) {
      try { parseChainFile(readFileSync(file, 'utf8')); } catch (e) { return { problem: e.message }; }
      const info = chainInfo(n);
      return info.problems ? { problem: info.problems.join('; ') } : { chain: info };
    },
  },
};

function checkName(kind, verb, n) {
  const usage = kind === 'chain' ? `krakenmcp chain ${verb}` : `krakenmcp ${verb}`;
  if (!n || !NAME.test(n)) fail(`usage: ${usage} <name> (lowercase letters, digits, - or _)`);
}

// Open the developer's file for <name> (created from a template when missing), then check it.
function editFile(kind, n) {
  checkName(kind, 'edit', n);
  const f = FILES[kind], file = join(f.dir(), `${n}.md`);
  const created = !existsSync(file);
  if (created) { mkdirSync(f.dir(), { recursive: true }); writeFileSync(file, f.template(n)); }
  if (editor()) openInEditor(file);
  const checked = f.check(n, file);
  if (checked.problem) { out({ file, problem: checked.problem }); process.exitCode = 1; return; }
  out({ file, created: created || undefined,
    note: editor() ? undefined
      : 'Set $VISUAL or $EDITOR to open it automatically; edit the file, then run this again to check it.',
    ...checked });
}

// Delete the developer's file: their own is gone, a built-in is back to its defaults.
function removeFile(kind, n) {
  checkName(kind, 'remove', n);
  const f = FILES[kind], file = join(f.dir(), `${n}.md`);
  if (!existsSync(file)) {
    fail(f.builtin(n) ? `${n} has no changes to remove; it is already the built-in`
      : `no ${kind} ${n} (no ${file})`);
  }
  rmSync(file);
  out({ removed: file, note: f.builtin(n) ? `${n} is back to ${f.reset}` : `${n} is gone` });
}

// ---- commands ----

function listTentacles() {
  out(knownNames(cwd).map((n) => {
    const t = resolveTentacle(n, cwd);
    return { name: n, settings: brief(t), sources: t.sources };
  }));
}

function chainCommand(sub, chainName) {
  if (sub === 'edit') return editFile('chain', chainName);
  if (sub === 'remove') return removeFile('chain', chainName);
  if (sub !== 'list' && sub !== undefined) fail('usage: krakenmcp chain list|edit <name>|remove <name>');
  const problems = userChains().problems;
  const safeInfo = (n) => {
    try { return chainInfo(n); } catch (e) { return { name: n, error: e.message }; }
  };
  const chains = knownChains().map(safeInfo);
  out({ dir: userChainDir(), chains, problems: problems.length ? problems : undefined });
}

function limit(n) {
  if (n !== undefined) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > 32) fail('limit must be an integer from 1 to 32');
    setSetting('max_parallel', v);
  }
  out({ max_parallel: maxParallel() });
}

function prune() {
  const days = Number(opt('--older-than') ?? 30);
  if (!(days >= 0)) fail('--older-than takes a number of days');
  out(pruneData({ olderThanDays: days, dryRun: flag('--dry-run'), worktrees: flag('--worktrees') }));
}

// Which agent CLIs are installed, their versions, and which tentacles need them.
function doctor() {
  const rep = agentReport(cwd, checkAgents);
  for (const a of rep.agents) {
    const used = a.used_by.length ? `  (used by ${a.used_by.join(', ')})` : '';
    const problem = a.problem ? `  ${a.problem}` : '';
    console.log(a.installed
      ? `ok       ${a.name.padEnd(9)} ${a.version ?? '?'}  ${a.path}${used}${problem}`
      : `missing  ${a.name.padEnd(9)} install: ${a.install_docs}${used}`);
  }
  for (const p of rep.problems) console.log(`problem  ${p}`);
  console.log(rep.note);
  process.exitCode = rep.problems.length ? 1 : 0;
}

function show(id) {
  const run = id ? getRun(id)
    : db.prepare(`SELECT * FROM runs WHERE result IS NOT NULL AND result != ''
                  ORDER BY created_at DESC LIMIT 1`).get();
  if (!run) fail(id ? `no run ${id}` : 'no run has a result yet');
  const file = join(PLANS_DIR, `${run.id}.md`), log = join(LOGS_DIR, `${run.id}.log`);
  if (showLog) {
    if (!existsSync(log)) fail(`run ${run.id} has no log (pruned, or never started)`);
    process.stdout.write(readFileSync(log, 'utf8'));
  } else if (openIt) {
    if (!existsSync(file)) fail(`run ${run.id} has no result file; use krakenmcp show ${run.id}`);
    const r = editor() ? spawnSync(`${editor()} "${file}"`, { stdio: 'inherit', shell: true })
      : spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { stdio: 'inherit' });
    const why = r.error ? `: ${r.error.message}` : '';
    if (r.error || (editor() && r.status)) fail(`could not open ${file}${why}`);
  } else {
    const body = existsSync(file) ? readFileSync(file, 'utf8') : run.result;
    const verdict = run.verdict ? `  ${run.verdict}` : '';
    const header = `# ${run.id}  ${run.tentacle}  ${run.status}${verdict}  ${run.agent} ${run.model ?? ''}`;
    console.log(header.trimEnd());
    console.log(`# task: ${run.task.split('\n')[0].slice(0, 120)}`);
    if (existsSync(file)) console.log(`# file: ${file}`);
    console.log(`\n${body ?? `(no result yet: ${run.error ?? run.status})`}`);
  }
}

const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const npmGlobalRoot = () => {
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  return r.error || r.status ? null : r.stdout.trim();
};

// Only a global git install updates itself; a checkout or an npm link must not be overwritten.
function updateKraken() {
  const gRoot = npmGlobalRoot();
  const gPkg = gRoot ? join(real(gRoot) ?? gRoot, 'krakenmcp') : null;
  let linked = false;
  try { linked = !!gPkg && lstatSync(gPkg).isSymbolicLink(); } catch { /* no global package */ }
  if (linked) fail('this is a linked or development install; update it with git, not npm');
  if (!gPkg || real(gPkg) !== (real(ROOT) ?? ROOT)) {
    fail(existsSync(join(ROOT, '.git'))
      ? 'you are running a local checkout; update it with "git pull"'
      : `not installed under the npm global root${gRoot ? ` (${gRoot})` : ''}; ` +
        'update it however you installed it');
  }
  // npm's output goes to stderr so stdout stays the JSON other commands print.
  const r = spawnSync('npm', ['install', '-g', INSTALL_SPEC],
    { stdio: ['inherit', process.stderr, 'inherit'] });
  if (r.error) fail(`could not run npm: ${r.error.message}`);
  if (r.status) fail(`npm install exited with status ${r.status}`);
  const pkgFile = join(gPkg, 'package.json');
  const pkg = existsSync(pkgFile) ? readFileSync(pkgFile, 'utf8') : null;
  const to = parseJson(pkg, {}).version ?? VERSION;
  const note = 'restart your MCP client: the server starts with the client';
  out({ updated: to !== VERSION, from: VERSION, to, note });
}

const COMMANDS = {
  list: listTentacles,
  edit: () => editFile('tentacle', name),
  remove: () => removeFile('tentacle', name),
  chain: () => chainCommand(name, arg2),
  limit: () => limit(name),
  prune,
  doctor,
  show: () => show(name),
  update: updateKraken,
};

try {
  const run = COMMANDS[cmd];
  if (run) run();
  else {
    const commands = 'doctor|show|list|edit|remove|chain|limit|prune|update|version';
    console.log(`usage: krakenmcp ${commands} [args] [--cwd <repo>]`);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
