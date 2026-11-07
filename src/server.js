#!/usr/bin/env node
// Kraken MCP server: tool definitions only. Runs: runs.js, control.js, status.js; branches:
// branches.js; chains: chain.js; settings: tentacles.js, chains.js.
// Usage guidance is sent once as server instructions; tool descriptions stay short because they are
// resent with every request the head makes.
import './quiet.js';
import { readFileSync } from 'node:fs';
import { createServer } from './mcp.js';
import { str, num, int, bool, oneOf, list, obj } from './schema.js';
import { resolve } from 'node:path';
import { agentInfo, checkAgents, AGENTS } from './agents.js';
import { getRun, VERSION } from './store.js';
import { cancelRun, resumeRun } from './control.js';
import { mergeRun, discardRun, syncBranch } from './branches.js';
import { maxParallel } from './scheduler.js';
import { startChain, cancelChain, resumeChain, isChainId } from './chain.js';
import { knownChains, resolveChain, checkChain, userChainDir, userChains } from './chains.js';
import { resolveTentacle, knownNames, userDir, userTentacles } from './tentacles.js';
import { startRun } from './runs.js';
import { clip } from './view.js';
import { status } from './status.js';
import { sessionSummary, agentReport } from './stats.js';

// Sent once when the client connects: how the head should use Kraken (edit src/instructions.md).
const INSTRUCTIONS = readFileSync(new URL('./instructions.md', import.meta.url), 'utf8').trim();

const SESSION = str({ default: 'default', description: 'Run group label' });
const CWD = str({ description: 'Repository path' });
const OVERRIDES = { agent: oneOf(Object.keys(AGENTS)), model: str(), effort: str() };
const CONTEXT_RUNS = list(str(), { maxItems: 5, description: 'Finished run ids to pass in as context' });
const RUN_ID = str({ required: true });

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ ...text(`Error: ${msg}`), isError: true });
const attempt = (fn) => {
  try {
    const r = fn();
    return text(r);
  } catch (e) { return fail(e.message); }
};

const server = createServer({
  info: { name: 'kraken', title: 'Kraken', version: VERSION,
    description: 'Delegate think / plan / execute / review work to headless coding agents.' },
  instructions: INSTRUCTIONS,
});
const dirOf = (cwd) => resolve(cwd ?? process.cwd());

// ---- start a tentacle ----

server.tool('think', {
  description: 'Escalate a hard reasoning problem to a stronger model (read-only). Returns analysis, options, ' +
    'a recommendation and open questions.',
  input: { problem: str({ required: true, description: 'Goal, constraints, what was tried' }), context_runs: CONTEXT_RUNS,
    cwd: CWD, ...OVERRIDES, session: SESSION },
}, async ({ problem, context_runs, cwd, agent, model, effort, session }) =>
  attempt(() => startRun('think', { input: problem, context_runs, cwd, session, overrides: { agent, model, effort } })));

server.tool('plan', {
  description: 'Write a file-by-file implementation plan (read-only).',
  input: { task: str({ required: true, description: 'Include the developer\'s answers to open questions' }),
    context_runs: CONTEXT_RUNS, cwd: CWD, ...OVERRIDES, session: SESSION },
}, async ({ task, context_runs, cwd, agent, model, effort, session }) =>
  attempt(() => startRun('plan', { input: task, context_runs, cwd, session, overrides: { agent, model, effort } })));

server.tool('execute', {
  description: 'Implement a finished plan on branch kraken/<run_id> in a separate worktree.',
  input: { plan_id: RUN_ID, ...OVERRIDES,
    verify: str({ description: 'Command to run after, e.g. "npm test"' }), session: SESSION },
}, async ({ plan_id, agent, model, effort, verify, session }) =>
  attempt(() => startRun('execute', { plan_id, session, overrides: { agent, model, effort, verify } })));

server.tool('review', {
  description: 'Review a run\'s branch (with its plan), or uncommitted changes when run_id is omitted. ' +
    'Starts with VERDICT: approve | changes_requested.',
  input: { run_id: str(), focus: str(), context_runs: CONTEXT_RUNS,
    cwd: CWD, ...OVERRIDES, session: SESSION },
}, async ({ run_id, focus, context_runs, cwd, agent, model, effort, session }) =>
  attempt(() => startRun('review', { input: focus, target_run: run_id, context_runs, cwd, session,
    overrides: { agent, model, effort } })));

server.tool('explain', {
  description: 'One-page map of how part of the codebase works (read-only).',
  input: { area: str({ required: true }), cwd: CWD, ...OVERRIDES, session: SESSION },
}, async ({ area, cwd, agent, model, effort, session }) =>
  attempt(() => startRun('explain', { input: area, cwd, session, overrides: { agent, model, effort } })));

server.tool('run', {
  description: 'Run any tentacle by name, including custom ones.',
  input: { tentacle: str({ required: true }), input: str(), plan_id: str(),
    context_runs: CONTEXT_RUNS, cwd: CWD, ...OVERRIDES, session: SESSION },
}, async ({ tentacle, input, plan_id, context_runs, cwd, agent, model, effort, session }) =>
  attempt(() => startRun(tentacle, { input, plan_id, context_runs, cwd, session, overrides: { agent, model, effort } })));

// ---- follow a run ----

server.tool('status', {
  description: 'A run\'s or chain\'s status, progress, metrics and result. Blocks up to wait_seconds while it is ' +
    'in progress (sends progress notifications when the client asks for them).',
  input: { run_id: str({ required: true, description: 'Run id or chain id' }),
    wait_seconds: num({ min: 0, max: 55, default: 0 }), full: bool({ default: false, description: 'Full result instead of an excerpt' }),
    since: int({ min: 0, description: 'Cursor from the previous status: returns only newer progress lines as feed' }) },
}, async (args, { progress }) => {
  try { return text(await status(args, progress)); } catch (e) { return fail(e.message); }
});

server.tool('resume', {
  description: 'Continue a run in its own agent session and branch, as a new run id. On a "waiting" run, input is ' +
    'the developer\'s answer to its question; on a finished run, a follow-up instruction; on a paused chain, the ' +
    'developer\'s reply (the chain continues).',
  input: { run_id: RUN_ID, input: str({ required: true }) },
}, async ({ run_id, input }) => attempt(() => (isChainId(run_id) ? resumeChain(run_id, input)
  : resumeRun(run_id, input, { answering: getRun(run_id)?.status === 'waiting' }))));

server.tool('cancel', {
  description: 'Stop a queued or running run, or a chain.',
  input: { run_id: RUN_ID },
}, async ({ run_id }) => attempt(() => (isChainId(run_id) ? cancelChain(run_id) : cancelRun(run_id))));

server.tool('update', {
  description: 'Merge the current branch into a run\'s branch (when it is behind or merge conflicts). On conflicts ' +
    'the run\'s agent resolves them as a new run, unless resolve is false.',
  input: { run_id: RUN_ID, resolve: bool({ default: true }) },
}, async ({ run_id, resolve: res }) => attempt(() => syncBranch(run_id, { resolve: res })));

server.tool('chain', {
  description: 'Run a chain of tentacle stages (default: plan -> execute -> review, with fix rounds). Each stage\'s ' +
    'autonomy decides whether it continues or waits for the developer. Returns a chain_id for status, resume and cancel.',
  input: { name: str({ description: 'Chain name (default "default")' }),
    task: str({ required: true, description: 'Include the developer\'s answers to open questions' }),
    verify: str({ description: 'Command to run after each write step, e.g. "npm test"' }),
    max_fix_rounds: int({ min: 0, max: 5 }), context_runs: CONTEXT_RUNS, cwd: CWD,
    overrides: list(obj({ stage: str({ required: true, description: 'Tentacle name of the stage' }), ...OVERRIDES }),
      { maxItems: 8 }),
    session: SESSION },
}, async ({ name, task, verify, max_fix_rounds, context_runs, cwd, overrides, session }) => attempt(() =>
  startChain({ name, task, verify, max_fix_rounds, context_runs, cwd, session, overrides })));

server.tool('merge', {
  description: 'Without confirm: a preview and confirm_token. With confirm: merge the run\'s branch into the ' +
    'current branch and clean up. Only confirm after the developer approves the preview.',
  input: { run_id: RUN_ID, confirm: str() },
}, async ({ run_id, confirm }) => attempt(() => mergeRun(run_id, confirm)));

server.tool('discard', {
  description: 'Delete a run\'s branch and worktree (cannot be undone; ask the developer first).',
  input: { run_id: RUN_ID },
}, async ({ run_id }) => attempt(() => discardRun(run_id)));

server.tool('session', {
  description: 'A session at a glance: what needs attention (running, waiting, ready to merge), recent runs and ' +
    'chains, and totals per tentacle/agent/model (outcomes, tokens, cost, duration, tool calls, diff size).',
  input: { session: SESSION },
}, async ({ session }) => text(sessionSummary(session)));

// ---- settings ----

server.tool('tentacles', {
  description: 'Tentacles in this repo with resolved settings and where each comes from; installed agents and the ' +
    'tentacles that need them; chains; limits.',
  input: { cwd: CWD, show_prompts: bool({ default: false }),
    check_agents: bool({ default: false, description: 'Also run each agent\'s --version (slower)' }) },
}, async ({ cwd, show_prompts, check_agents }) => {
  const dir = dirOf(cwd);
  const list = knownNames(dir).map((n) => {
    try {
      const t = resolveTentacle(n, dir);
      return { name: n, builtin: t.builtin, needs_plan: t.needs_plan, user_file: t.user_file,
        settings: { ...t.settings, prompt: show_prompts ? t.settings.prompt : clip(t.settings.prompt, 120) },
        sources: t.sources };
    } catch (e) { return { name: n, error: e.message }; }
  });
  const agents = agentReport(dir, check_agents ? checkAgents : agentInfo);
  const chains = knownChains().map((n) => {
    try {
      const c = resolveChain(n), k = checkChain(c, dir);
      return { name: n, builtin: c.builtin, description: c.description, user_file: c.user_file,
        max_fix_rounds: c.max_fix_rounds,
        stages: k.stages.map((s) => ({ tentacle: s.tentacle, kind: s.kind, autonomy: s.autonomy, autonomy_source: s.autonomy_source })),
        problems: k.problems.length ? k.problems : undefined };
    } catch (e) { return { name: n, error: e.message }; }
  });
  const chainProblems = userChains().problems;
  return text({ repo: list[0]?.repo, tentacles: list, chains, agents: agents.agents,
    agent_problems: agents.problems.length ? agents.problems : undefined,
    limits: { max_parallel: maxParallel() },
    user_files: { dir: userDir(), problems: userTentacles().problems.length ? userTentacles().problems : undefined },
    chain_files: { dir: userChainDir(), problems: chainProblems.length ? chainProblems : undefined } });
});

server.start();
