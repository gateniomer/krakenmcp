#!/usr/bin/env node
// Developer CLI. Tentacle settings live in ~/.kraken/tentacles/*.md; MCP clients can read them, never change them.
//
//   krakenmcp list                          [--cwd <repo>]
//   krakenmcp edit <name>                   open ~/.kraken/tentacles/<name>.md (created if missing), then check it
//   krakenmcp remove <name>                 delete that file: your tentacle is gone, a built-in is back to its defaults
//   krakenmcp doctor                        check installed agent CLIs (exit 1 if a tentacle needs a missing one)
//   krakenmcp limit [n]                     show/set max parallel runs (default 3)
//   krakenmcp prune [--older-than 30] [--dry-run] [--worktrees]
//        delete logs/result files and stored prompts of runs finished more than N days ago; list
//        unmerged worktrees (--worktrees also discards the stale ones)
//   krakenmcp mode [ask|auto]               show/set approval: auto merges approved, verified, conflict-free branches
//   krakenmcp show [run_id] [--open|--log]  a run's full result (default: the newest run with one);
//        --open opens the result file in $VISUAL / $EDITOR, --log prints the raw agent output
import './quiet.js';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { knownNames, resolveTentacle, NAME, userDir, userTentacles, tentacleTemplate, BUILTIN } from './tentacles.js';
import { PLANS_DIR, LOGS_DIR, db, getRun, setSetting } from './store.js';
import { maxParallel } from './scheduler.js';
import { approvalMode } from './branches.js';
import { pruneData } from './prune.js';
import { checkAgents } from './agents.js';
import { agentReport } from './runs.js';

const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (f) => { const i = argv.indexOf(f); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };

const openIt = flag('--open'), showLog = flag('--log');
const cwd = resolve(opt('--cwd') ?? process.cwd());
const [cmd, name] = argv;
const out = (o) => console.log(JSON.stringify(o, null, 2));

try {
  switch (cmd) {
    case 'list':
      out(knownNames(cwd).map((n) => {
        const t = resolveTentacle(n, cwd);
        return { name: n, settings: { ...t.settings, prompt: `${t.settings.prompt.slice(0, 60)}…` }, sources: t.sources };
      }));
      break;
    case 'edit': {
      // krakenmcp edit <name>: your tentacle file for <name> (a built-in or your own), in $VISUAL / $EDITOR
      if (!name || !NAME.test(name)) throw new Error('usage: krakenmcp edit <name> (lowercase letters, digits, - or _)');
      const file = join(userDir(), `${name}.md`);
      const created = !existsSync(file);
      if (created) { mkdirSync(userDir(), { recursive: true }); writeFileSync(file, tentacleTemplate(name)); }
      const editor = process.env.VISUAL || process.env.EDITOR;
      if (editor) {
        const r = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
        if (r.error || r.status) throw new Error(`the editor exited with an error${r.error ? `: ${r.error.message}` : ''}`);
      }
      const problem = userTentacles().problems.find((p) => p.startsWith(file));
      if (problem) { out({ file, problem: problem.slice(file.length + 2) }); process.exitCode = 1; break; }
      const t = resolveTentacle(name, cwd);
      out({ file, created: created || undefined,
        note: editor ? undefined : 'Set $VISUAL or $EDITOR to open it automatically; edit the file, then run this again to check it.',
        settings: { ...t.settings, prompt: `${t.settings.prompt.slice(0, 60)}…` }, sources: t.sources });
      break;
    }
    case 'remove': {
      // krakenmcp remove <name>: delete your tentacle file (built-ins cannot be removed, only reset)
      if (!name || !NAME.test(name)) throw new Error('usage: krakenmcp remove <name>');
      const file = join(userDir(), `${name}.md`);
      if (!existsSync(file)) {
        throw new Error(BUILTIN[name] ? `${name} has no changes to remove; it is already the built-in`
          : `no tentacle ${name} (no ${file})`);
      }
      rmSync(file);
      out({ removed: file, note: BUILTIN[name] ? `${name} is back to the built-in settings and prompt` : `${name} is gone` });
      break;
    }
    case 'limit': {
      // krakenmcp limit [n]: show or set how many runs may run at once (others wait as queued)
      if (name !== undefined) {
        const n = Number(name);
        if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error('limit must be an integer from 1 to 32');
        setSetting('max_parallel', n);
      }
      out({ max_parallel: maxParallel() });
      break;
    }
    case 'prune': {
      // krakenmcp prune [--older-than 30] [--dry-run] [--worktrees]
      const days = Number(opt('--older-than') ?? 30);
      if (!(days >= 0)) throw new Error('--older-than takes a number of days');
      out(pruneData({ olderThanDays: days, dryRun: flag('--dry-run'), worktrees: flag('--worktrees') }));
      break;
    }
    case 'doctor': {
      // krakenmcp doctor: which agent CLIs are installed, their versions, and what needs them
      const rep = agentReport(cwd, checkAgents);
      for (const a of rep.agents) {
        const used = a.used_by.length ? `  (used by ${a.used_by.join(', ')})` : '';
        console.log(a.installed ? `ok       ${a.name.padEnd(9)} ${a.version ?? '?'}  ${a.path}${used}${a.problem ? `  ${a.problem}` : ''}`
          : `missing  ${a.name.padEnd(9)} install: ${a.install_docs}${used}`);
      }
      for (const p of rep.problems) console.log(`problem  ${p}`);
      console.log(rep.note);
      process.exitCode = rep.problems.length ? 1 : 0;
      break;
    }
    case 'mode': {
      // krakenmcp mode [ask|auto]: whether merge asks the developer (default) or lands approved work by itself
      if (name !== undefined) {
        if (!['ask', 'auto'].includes(name)) throw new Error('mode is "ask" or "auto"');
        setSetting('approval_mode', name === 'auto' ? 'auto' : null);
      }
      out({ approval_mode: approvalMode(),
        note: approvalMode() === 'auto'
          ? 'merge(run_id) and pipelines merge by themselves when the latest review approves, verify passed, and nothing ' +
            'conflicts or is uncommitted. Anything else still shows a preview and waits for you. discard always asks.'
          : 'merge(run_id) shows a preview; it merges only after you approve it.' });
      break;
    }
    case 'show': {
      const run = name ? getRun(name)
        : db.prepare("SELECT * FROM runs WHERE result IS NOT NULL AND result != '' ORDER BY created_at DESC LIMIT 1").get();
      if (!run) throw new Error(name ? `no run ${name}` : 'no run has a result yet');
      const file = join(PLANS_DIR, `${run.id}.md`), log = join(LOGS_DIR, `${run.id}.log`);
      if (showLog) {
        if (!existsSync(log)) throw new Error(`run ${run.id} has no log (pruned, or never started)`);
        process.stdout.write(readFileSync(log, 'utf8'));
      } else if (openIt) {
        if (!existsSync(file)) throw new Error(`run ${run.id} has no result file; use krakenmcp show ${run.id}`);
        const editor = process.env.VISUAL || process.env.EDITOR;
        const r = editor ? spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true })
          : spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { stdio: 'inherit' });
        if (r.error || (editor && r.status)) throw new Error(`could not open ${file}${r.error ? `: ${r.error.message}` : ''}`);
      } else {
        const body = existsSync(file) ? readFileSync(file, 'utf8') : run.result;
        console.log(`# ${run.id}  ${run.tentacle}  ${run.status}${run.verdict ? `  ${run.verdict}` : ''}  ${run.agent} ${run.model ?? ''}`.trimEnd());
        console.log(`# task: ${run.task.split('\n')[0].slice(0, 120)}`);
        if (existsSync(file)) console.log(`# file: ${file}`);
        console.log(`\n${body ?? `(no result yet: ${run.error ?? run.status})`}`);
      }
      break;
    }
    default:
      console.log('usage: krakenmcp doctor|show|list|edit|remove|limit|mode|prune ' +
        '[args] [--cwd <repo>]');
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
