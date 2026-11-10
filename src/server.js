#!/usr/bin/env node
// Kraken MCP server: tool definitions only. Runs: runs.js, control.js, status.js; branches:
// branches.js; chains: chain.js; settings: tentacles.js, chains.js; reports: stats.js.
// Usage guidance is sent once as server instructions; tool descriptions stay short because they are
// resent with every request the head makes.
import './quiet.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from './mcp.js';
import { str, num, int, bool, oneOf, list, obj } from './schema.js';
import { AGENTS } from './agents.js';
import { getRun, VERSION } from './store.js';
import { cancelRun, resumeRun } from './control.js';
import { mergeRun, discardRun, syncBranch } from './branches.js';
import { startChain, cancelChain, resumeChain, isChainId } from './chain.js';
import { startRun } from './runs.js';
import { status } from './status.js';
import { sessionSummary, settingsReport } from './stats.js';

// Sent once when the client connects: how the head should use Kraken (edit src/instructions.md).
const INSTRUCTIONS = readFileSync(new URL('./instructions.md', import.meta.url), 'utf8').trim();

const SESSION = str({ default: 'default', description: 'Run group label' });
const CWD = str({ description: 'Repository path' });
const OVERRIDES = { agent: oneOf(Object.keys(AGENTS)), model: str(), effort: str() };
const CONTEXT_RUNS = list(str(), { maxItems: 5, description: 'Finished run ids to pass in as context' });
const RUN_ID = str({ required: true });
const TASK = str({ required: true, description: 'Include the developer\'s answers to open questions' });

const json = (o) => (typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const text = (o) => ({ content: [{ type: 'text', text: json(o) }] });
const failed = (msg) => ({ ...text(`Error: ${msg}`), isError: true });
const attempt = (fn) => {
  try { return text(fn()); } catch (e) { return failed(e.message); }
};
const overridesOf = ({ agent, model, effort }) => ({ agent, model, effort });
const start = (tentacle, args, opts) => attempt(() => startRun(tentacle, { ...opts,
  cwd: args.cwd, session: args.session, context_runs: args.context_runs, overrides: overridesOf(args) }));

const server = createServer({
  info: { name: 'kraken', title: 'Kraken', version: VERSION,
    description: 'Delegate think / plan / execute / review work to headless coding agents.' },
  instructions: INSTRUCTIONS,
});

// ---- start a tentacle ----

server.tool('think', {
  description: 'Escalate a hard reasoning problem to a stronger model (read-only). Returns analysis, ' +
    'options, a recommendation and open questions.',
  input: { problem: str({ required: true, description: 'Goal, constraints, what was tried' }),
    context_runs: CONTEXT_RUNS, cwd: CWD, ...OVERRIDES, session: SESSION },
}, async (a) => start('think', a, { input: a.problem }));

server.tool('plan', {
  description: 'Write a file-by-file implementation plan (read-only).',
  input: { task: TASK, context_runs: CONTEXT_RUNS, cwd: CWD, ...OVERRIDES, session: SESSION },
}, async (a) => start('plan', a, { input: a.task }));

server.tool('execute', {
  description: 'Implement a plan on branch kraken/<run_id> in a separate worktree. The plan is a finished ' +
    'plan run (plan_id) or a Markdown file in the repo (plan_file, optionally one section of it). A plan ' +
    'with 2+ "Stage" headings runs one fresh agent session per stage, committing after each.',
  input: { plan_id: str({ description: 'A finished plan run' }),
    plan_file: str({ description: 'Plan file, relative to cwd (instead of plan_id)' }),
    section: str({ description: 'Only this heading of plan_file (case-insensitive substring)' }),
    continue_run: str({ description: 'Continue on this earlier execute run\'s branch and worktree, with a ' +
      'fresh agent session (one stage at a time without merging in between)' }),
    cwd: CWD, ...OVERRIDES,
    verify: str({ description: 'Command to run once at the end, e.g. "npm test"' }),
    stage_verify: str({ description: 'Cheaper command to run after each stage' }), session: SESSION },
}, async ({ plan_id, plan_file, section, continue_run, cwd, verify, stage_verify, session, ...a }) =>
  attempt(() => {
    if (!plan_id && !plan_file) throw new Error('pass plan_id or plan_file');
    return startRun('execute', { plan_id, plan_file, section, continue_run, cwd, session,
      overrides: { ...overridesOf(a), verify, stage_verify } });
  }));

server.tool('review', {
  description: 'Review a run\'s branch (with its plan), everything since a commit (base), or uncommitted ' +
    'changes when neither is given. Starts with VERDICT: approve | changes_requested.',
  input: { run_id: str(), base: str({ description: 'Review all changes in cwd since this commit, committed ' +
    'or not (e.g. "HEAD~3" or a sha), instead of only uncommitted changes' }),
    focus: str(), context_runs: CONTEXT_RUNS, cwd: CWD, ...OVERRIDES, session: SESSION },
}, async (a) => start('review', a, { input: a.focus, target_run: a.run_id, base: a.base }));

server.tool('explain', {
  description: 'One-page map of how part of the codebase works (read-only).',
  input: { area: str({ required: true }), cwd: CWD, ...OVERRIDES, session: SESSION },
}, async (a) => start('explain', a, { input: a.area }));

server.tool('run', {
  description: 'Run any tentacle by name, including custom ones.',
  input: { tentacle: str({ required: true }), input: str(), plan_id: str(), plan_file: str(), section: str(),
    context_runs: CONTEXT_RUNS, cwd: CWD, ...OVERRIDES, session: SESSION },
}, async (a) => start(a.tentacle, a,
  { input: a.input, plan_id: a.plan_id, plan_file: a.plan_file, section: a.section }));

server.tool('chain', {
  description: 'Run a chain of tentacle stages (default: plan -> execute -> review, with fix rounds). ' +
    'Each stage\'s autonomy decides whether it continues or waits for the developer. ' +
    'Returns a chain_id for status, resume and cancel.',
  input: { name: str({ description: 'Chain name (default "default")' }), task: TASK,
    verify: str({ description: 'Command to run after each write step, e.g. "npm test"' }),
    max_fix_rounds: int({ min: 0, max: 5 }), context_runs: CONTEXT_RUNS, cwd: CWD,
    overrides: list(obj({ stage: str({ required: true, description: 'Tentacle name of the stage' }),
      ...OVERRIDES }), { maxItems: 8 }),
    session: SESSION },
}, async (a) => attempt(() => startChain(a)));

// ---- follow and steer a run ----

server.tool('status', {
  description: 'A run\'s or chain\'s status, progress, metrics and result. Blocks up to wait_seconds while ' +
    'it is in progress (sends progress notifications when the client asks for them).',
  input: { run_id: str({ required: true, description: 'Run id or chain id' }),
    wait_seconds: num({ min: 0, max: 55, default: 0 }),
    full: bool({ default: false, description: 'Full result instead of an excerpt' }),
    since: int({ min: 0, description: 'Cursor from the previous status: only newer progress lines' }) },
}, async (args, { progress }) => {
  try { return text(await status(args, progress)); } catch (e) { return failed(e.message); }
});

server.tool('resume', {
  description: 'Continue a run in its own agent session and branch, as a new run id. On a "waiting" run, ' +
    'input is the developer\'s answer to its question; on a finished run, a follow-up instruction; on a ' +
    'paused chain, the developer\'s reply (the chain continues).',
  input: { run_id: RUN_ID, input: str({ required: true }) },
}, async ({ run_id, input }) => attempt(() => (isChainId(run_id) ? resumeChain(run_id, input)
  : resumeRun(run_id, input, { answering: getRun(run_id)?.status === 'waiting' }))));

server.tool('cancel', {
  description: 'Stop a queued or running run, or a chain.',
  input: { run_id: RUN_ID },
}, async ({ run_id }) => attempt(() => (isChainId(run_id) ? cancelChain(run_id) : cancelRun(run_id))));

server.tool('update', {
  description: 'Merge the current branch into a run\'s branch (when it is behind or merge conflicts). ' +
    'On conflicts the run\'s agent resolves them as a new run, unless resolve is false.',
  input: { run_id: RUN_ID, resolve: bool({ default: true }) },
}, async ({ run_id, resolve: res }) => attempt(() => syncBranch(run_id, { resolve: res })));

server.tool('merge', {
  description: 'Without confirm: a preview and confirm_token. With confirm: merge the run\'s branch into ' +
    'the current branch and clean up. Only confirm after the developer approves the preview.',
  input: { run_id: RUN_ID, confirm: str() },
}, async ({ run_id, confirm }) => attempt(() => mergeRun(run_id, confirm)));

server.tool('discard', {
  description: 'Delete a run\'s branch and worktree (cannot be undone; ask the developer first).',
  input: { run_id: RUN_ID },
}, async ({ run_id }) => attempt(() => discardRun(run_id)));

// ---- overview and settings ----

server.tool('session', {
  description: 'A session at a glance: what needs attention (running, waiting, ready to merge), recent ' +
    'runs and chains, and totals per tentacle/agent/model (outcomes, tokens, cost, duration, tool calls).',
  input: { session: SESSION },
}, async ({ session }) => text(sessionSummary(session)));

server.tool('tentacles', {
  description: 'Tentacles in this repo with resolved settings and where each comes from; installed agents ' +
    'and the tentacles that need them; chains; limits.',
  input: { cwd: CWD, show_prompts: bool({ default: false }),
    check_agents: bool({ default: false, description: 'Also run each agent\'s --version (slower)' }) },
}, async ({ cwd, show_prompts, check_agents }) =>
  text(settingsReport(resolve(cwd ?? process.cwd()), { showPrompts: show_prompts, checkAll: check_agents })));

server.start();
