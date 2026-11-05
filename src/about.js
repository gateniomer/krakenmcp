// "about": what Kraken is, with the ASCII kraken from assets/logo.svg and live config.
// Used by the MCP `about` tool (plain text) and `krakenmcp about` (ANSI colors).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, DATA_DIR } from './store.js';
import { agentInfo } from './agents.js';
import { knownNames, resolveTentacle } from './tentacles.js';

export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// Mirrors the logo: mottled mantle, hooded amber eyes with bar pupils, two tentacles curling up
// beside the mantle, two curling out to the sides, four reaching down; @ = red connection tips.
const ART = String.raw`
                         .
                       .' '.
           @         .'  o  '.         @
          ( \       /  .   o  \       / )
           \ \     /  o   .    \     / /
            \ \   |  .    o  .  |   / /
             \ \  |   o  .   o  |  / /
              \ \ |  _-_     _-_ | / /
      @        ) )| (=O=)   (=O=) |( (        @
     ( \      / / |  '-'     '-'  | \ \      / )
      \ '----' /   \   '.___.'   /   \ '----' /
       '------'  /  '._________.'  \  '------'
                / /    / |   | \    \ \
               / /    / /     \ \    \ \
              ( (    ( (       ) )    ) )
               @      @         @      @`.slice(1);

const C = { red: '\x1b[31m', amber: '\x1b[33m', body: '\x1b[38;5;61m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };

function colorArt() {
  return ART.split('\n').map((line) => C.body + line
    .replace(/@/g, `${C.red}@${C.body}`)
    .replace(/=O=/g, `=${C.amber}O${C.body}=`) + C.off).join('\n');
}

export function aboutText({ cwd = process.cwd(), color = false } = {}) {
  const b = (s) => (color ? `${C.bold}${s}${C.off}` : s);
  const d = (s) => (color ? `${C.dim}${s}${C.off}` : s);
  const red = (s) => (color ? `${C.red}${s}${C.off}` : s);

  const tentacles = knownNames(cwd).map((n) => {
    try {
      const t = resolveTentacle(n, cwd);
      const s = t.settings;
      return `  ${n.padEnd(10)} ${s.access.padEnd(5)} ${`${s.agent} ${s.model ?? '(default)'}${s.effort ? ` #${s.effort}` : ''}`.padEnd(42)} ${d(`agent from ${t.sources.agent}`)}`;
    } catch (e) { return `  ${n.padEnd(10)} ${red(`error: ${e.message}`)}`; }
  });
  const agents = agentInfo().map((a) => `  ${a.name.padEnd(10)} ${a.installed ? 'installed' : red('not installed')}${a.path ? d(`  ${a.path}`) : ''}`);

  return [
    color ? colorArt() : ART,
    '',
    b(`  KrakenMCP v${VERSION}  -  one coordinator, many tentacles`),
    '',
    '  Kraken lets the agent you are talking to delegate work to other headless',
    '  coding agents (claude, codex, cursor, opencode, aider), each with its model and effort.',
    '  Every action is a "tentacle": a named job with a prompt, an access level',
    '  (read = cannot edit, write = edits in a git worktree) and saved settings.',
    '  Runs happen in the background; progress, tokens, cost and diffs go to SQLite.',
    '',
    b('  Tentacles in this repo'),
    ...tentacles,
    '',
    b('  Agents'),
    ...agents,
    '',
    b('  Feature flow'),
    '  1. talk it through with your coordinator     (it advises you)',
    '  2. think(problem)                             hard logic -> options, recommendation, open questions',
    '  3. you answer the open questions',
    '  4. plan(task, context_runs: [think_id])       file-by-file steps',
    '  5. execute(plan_id, verify: "npm test")       code on branch kraken/<run_id>',
  '  6. review(run_id) -> merge(run_id)            check it, preview, you approve, it lands',
    '     or: pipeline(task, verify)                 steps 4-6 by itself, stops before merge',
    '',
    b('  Tools'),
    '  think, plan, execute, run        start a tentacle (returns run_id at once)',
  '  review, explain                  check a branch / map an area',
  '  cancel, merge, discard           stop a run; land or drop its kraken/<run_id> branch',
    '  update(run_id)                   merge your branch into the run\'s; the agent resolves conflicts',
    '  pipeline(task, verify)           plan -> execute -> review (+ fix rounds), stops before merge',
  '  resume                           answer a waiting run, or follow up in the same session',
    '  status(run_id, wait_seconds)     progress, result, metrics',
    '  session                          what needs you, history, totals per tentacle/agent/model',
    '  tentacles                        settings, agents, limits (built-in -> user file -> global -> repo file -> repo -> call)',
    '  (CLI) krakenmcp about | set      this page; change settings',
    '',
    d(`  repo: ${cwd}`),
    d(`  data: ${DATA_DIR}`),
    d('  config: krakenmcp doctor | show | list | set | limit | mode | budget | trust | export | import | prune | log'),
  ].join('\n');
}
