#!/usr/bin/env node
// Kraken MCP server: tool definitions. Run logic lives in runs.js / control.js /
// branches.js / scheduler.js, settings in tentacles.js.
// Usage guidance is sent once as server instructions; tool descriptions stay short because they are
// resent with every request the head makes.
import './quiet.js';
import { createServer } from './mcp.js';
import { str, num, int, bool, oneOf, list, obj } from './schema.js';
import { resolve } from 'node:path';
import { agentInfo, checkAgents, AGENTS } from './agents.js';
import { IN_PROGRESS, getRun, getChain, VERSION } from './store.js';
import { cancelRun, resumeRun } from './control.js';
import { mergeRun, discardRun, syncBranch } from './branches.js';
import { pump, maxParallel } from './scheduler.js';
import { startChain, cancelChain, resumeChain, describeChain, isChainId, chainStatus, chainFeed,
  chainSummary, chainCard } from './chain.js';
import { knownChains, resolveChain, checkChain, userChainDir, userChains } from './chains.js';
import { resolveTentacle, knownNames, userDir, userTentacles } from './tentacles.js';
import { startRun, describe, sessionSummary, clip, agentReport, runFeed, runSummary, runCard } from './runs.js';

const INSTRUCTIONS = `Kraken delegates work to other headless coding agents. Each action is a "tentacle"; you are the head
(the agent the developer talks to) that sends work to them.
Runs are asynchronous: every start tool returns a run_id at once. Then call status(run_id, wait_seconds: 50, since: 0),
and on each later call pass the cursor it returned as since. Do not poll faster.
Cards: every start tool, resume and status reply carries "card", a small bordered box. Show it to the developer
every time you get one, as-is in a code block: when you call a tentacle, on every status reply (also when there
are no new feed lines), and when it finishes. While it runs, put the new feed lines under the card in the same code
block, one per line, nothing added. Never redraw, shorten or reword a card; add at most one short line of your own.

After every finished run or chain, follow its \`next\`:
- "ask: …" show the result, suggest exactly that step, then stop and wait for the developer.
- "auto: …" the developer allowed this step without asking (the tentacle's autonomy is auto): take it.
- "stop: …" report to the developer and wait.

Usual order (not a script): discuss the feature with the developer yourself; you are the one who advises them.
think only for hard logic (multi-system changes, state/timing/concurrency/networking/persistence, correctness
arguments, or after a failed attempt), never for simple edits: it is slow and expensive; relay its recommendation in
your own words and ask its open questions. Then plan(task + the developer's answers, context_runs: [think run_id]),
execute(plan_id) (on branch kraken/<run_id> in a separate worktree), review(run_id) (VERDICT: approve |
changes_requested), then merge. To fix things on the same branch use resume(run_id, instruction).
merge(run_id) returns a preview. Show it to the developer and call merge(run_id, confirm) only after
they explicitly approve. If merge reports auto: true it already landed (the review tentacle's autonomy is auto); tell the developer.
discard(run_id) throws the work away: only with the developer's approval, always.
If merge reports conflicts (or its preview predicts them), call update(run_id): it merges the current branch
into the run's branch and, on conflicts, resumes the agent to resolve them.

Chains: chain(task, verify?) runs the developer's configured stage list (default: plan -> execute -> review, with fix
rounds), pausing after each stage whose autonomy is ask; chain(name: …) runs another (tentacles() lists them). A chain
that is "waiting" with a pause continues with resume(chain_id, their reply); one waiting on a question is answered
through its stage run.

Session override: if the developer explicitly tells you to work in auto for this session, treat every "ask:" next as
"auto:" until they say otherwise. It never covers questions, "stop:", verify_failed, discard or merge blockers:
confirm a merge only when auto_merge_blocked_by is empty.

If status is "waiting", the agent asked a question only the developer can answer: ask them, then call
resume(run_id, their reply). A run stopped as "over_budget" hit its max_cost_usd / max_tokens.
Failures stop you: if a tool returns an error, or a run ends as "failed", "timeout" or "over_budget",
do not retry it and do not switch agent, model or effort on your own. Report the error to the developer
immediately and ask how to proceed. A "verify_failed" run keeps its commit; report the verify output.
Use explain(area) instead of reading many files yourself.
For questions that need current information from the web (APIs, versions, library choices), call
run(tentacle: "research", input: question) instead of answering from memory.
When a think, plan, review, explain or research run finishes, give the developer its result_file path so they can read
the full text (or tell them: krakenmcp show <run_id>).
Settings are the developer's: tentacle files in ~/.kraken/tentacles/ and chain files in ~/.kraken/chains/.`;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
}, async ({ run_id, wait_seconds, full, since }, { progress }) => {
  pump(); // also recovers runs whose worker died, and starts queued runs if there is room
  const pipe = isChainId(run_id);
  const load = () => (pipe ? getChain(run_id) : getRun(run_id));
  const busy = (x) => (pipe ? chainStatus(x) === 'running' : IN_PROGRESS.includes(x.status));
  let item = load();
  if (!item) return fail(`no ${pipe ? 'chain' : 'run'} ${run_id}`);
  const started = Date.now(), deadline = started + wait_seconds * 1000;
  let lastKey = null;
  while (busy(item) && Date.now() < deadline) {
    await sleep(1000);
    item = load();
    if (progress) {
      const live = progressNote(pipe ? item.current_run : run_id, pipe ? item.stage : null, pipe ? run_id : null);
      const key = live?.key ?? live?.headline;
      if (key && (key !== lastKey || (Date.now() - started) % 10_000 < 1000)) {
        lastKey = key;
        progress(Math.round((Date.now() - started) / 1000), live.headline);
      }
    }
  }
  const sum = pipe ? chainSummary(item) : runSummary(item);
  const card = pipe ? chainCard(item) : runCard(item);
  if (since === undefined) {
    return text(pipe ? { card, ...describeChain(item, full), summary: sum }
      : { card, ...describe(item, full), summary: sum });
  }
  const live = pipe ? chainFeed(item, since, !busy(item)) : runFeed(item, since, !busy(item));
  if (busy(item)) { // compact reply: only what the head shows to the developer
    return text({ card, id: item.id, status: sum.status, stage: sum.stage, elapsed_s: sum.elapsed_s, cost_usd: sum.cost_usd,
      summary: sum, feed: live.feed, cursor: live.cursor,
      next: `show card as-is in a code block with the feed lines under it (even if there are none), then call status again with since: ${live.cursor}` });
  }
  return text(pipe ? { card, ...describeChain(item, full, live), summary: sum }
    : { card, ...describe(item, full), ...live, summary: sum });
});

// The live summary of a run or chain, for progress notifications (key = headline without time).
function progressNote(runId, stage, chainId) {
  if (chainId) {
    const c = getChain(chainId);
    return c ? chainSummary(c) : null;
  }
  const run = runId ? getRun(runId) : null;
  return run ? runSummary(run, stage) : null;
}

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
