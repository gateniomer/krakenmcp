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
import { IN_PROGRESS, getRun, getPipeline, lastMessageId, lastPipelineMessageId, pipelineRuns, VERSION } from './store.js';
import { cancelRun, resumeRun } from './control.js';
import { mergeRun, discardRun, syncBranch } from './branches.js';
import { pump, maxParallel } from './scheduler.js';
import { approvalMode } from './branches.js';
import { startPipeline, cancelPipeline, describePipeline, isPipelineId, pipelineStatus, pipelineFeed } from './pipeline.js';
import { resolveTentacle, knownNames, userDir, userTentacles } from './tentacles.js';
import { startRun, describe, sessionSummary, clip, agentReport, runFeed, runLabel } from './runs.js';

const INSTRUCTIONS = `Kraken delegates work to other headless coding agents. Each action is a "tentacle"; you are the head
(the agent the developer talks to) that sends work to them.
Runs are asynchronous: every start tool returns a run_id at once. Then call status(run_id, wait_seconds: 50, since: 0),
and on each later call pass the cursor it returned as since. While the run is in progress, show the developer the
returned feed lines as they are (in a code block, one per line, nothing added) before the next status call. When
status is "waiting", ask the developer the question and resume. Do not poll faster.

Feature flow:
1. Discuss the feature with the developer yourself; you are the one who advises them.
2. For hard logic (multi-system changes, state/timing/concurrency/networking/persistence, correctness
   arguments, or after a failed attempt) call think. Never for simple edits: it is slow and expensive.
   Relay its recommendation in your own words and ask the developer its open questions.
3. plan(task + the developer's answers, context_runs: [think run_id]).
4. execute(plan_id). It works on branch kraken/<run_id> in a separate worktree.
5. review(run_id) before merging. The result starts with VERDICT: approve | changes_requested.
6. merge(run_id) returns a preview. Show it to the developer and call merge(run_id, confirm) only after
   they explicitly approve. (If the developer chose approval mode "auto", merge merges at once when the review
   approved and verify passed; it says so with auto: true. Tell the developer it landed.)
   To fix things on the same branch use resume(run_id, instruction);
   to throw the work away use discard(run_id), also only with the developer's approval.

Shortcut: pipeline(task, verify) runs plan -> execute -> review (and fix rounds on changes_requested) by
itself and stops before merge; poll it with status(pipeline_id) like a run.
If merge reports conflicts (or its preview predicts them), call update(run_id): it merges the current branch
into the run's branch and, on conflicts, resumes the agent to resolve them.

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
Settings are the developer's: they change them by editing tentacle files in ~/.kraken/tentacles/.`;

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
  description: 'A run\'s or pipeline\'s status, progress, metrics and result. Blocks up to wait_seconds while it is ' +
    'in progress (sends progress notifications when the client asks for them).',
  input: { run_id: str({ required: true, description: 'Run id or pipeline id' }),
    wait_seconds: num({ min: 0, max: 55, default: 0 }), full: bool({ default: false, description: 'Full result instead of an excerpt' }),
    since: int({ min: 0, description: 'Cursor from the previous status: returns only newer progress lines as feed' }) },
}, async ({ run_id, wait_seconds, full, since }, { progress }) => {
  pump(); // also recovers runs whose worker died, and starts queued runs if there is room
  const pipe = isPipelineId(run_id);
  const load = () => (pipe ? getPipeline(run_id) : getRun(run_id));
  const busy = (x) => (pipe ? pipelineStatus(x) === 'running' : IN_PROGRESS.includes(x.status));
  let item = load();
  if (!item) return fail(`no ${pipe ? 'pipeline' : 'run'} ${run_id}`);
  const started = Date.now(), deadline = started + wait_seconds * 1000;
  let lastNote = null;
  while (busy(item) && Date.now() < deadline) {
    await sleep(1000);
    item = load();
    if (progress) {
      const note = progressNote(pipe ? item.current_run : run_id, pipe ? item.stage : null, pipe ? run_id : null);
      if (note !== lastNote || (Date.now() - started) % 10_000 < 1000) {
        lastNote = note;
        progress(Math.round((Date.now() - started) / 1000), note);
      }
    }
  }
  if (since === undefined) return text(pipe ? describePipeline(item, full) : describe(item, full));
  const live = pipe ? pipelineFeed(item, since) : runFeed(item, since);
  if (busy(item)) { // compact reply: only what the head shows to the developer
    const cur = pipe ? (item.current_run && getRun(item.current_run)) : item;
    const t0 = item.started_at ?? item.created_at;
    return text({ id: item.id, status: pipe ? pipelineStatus(item) : item.status, stage: pipe ? item.stage : undefined,
      elapsed_s: t0 ? Math.round((Date.now() - new Date(t0.includes('T') ? t0 : `${t0.replace(' ', 'T')}Z`)) / 1000) : undefined,
      cost_usd: pipe ? pipelineRuns(item.id).reduce((a, r) => a + (r.cost_usd ?? 0), 0) || undefined : item.cost_usd ?? undefined, feed: live.feed, cursor: live.cursor,
      next: `show the feed lines to the developer as they are, then call status again with since: ${live.cursor}` });
  }
  return text(pipe ? describePipeline(item, full, live) : { ...describe(item, full), ...live });
});

// Latest feed line of a run or pipeline, for progress notifications.
function progressNote(runId, stage, pipelineId) {
  if (!runId) return stage ?? 'starting';
  const run = getRun(runId);
  const live = pipelineId
    ? pipelineFeed(getPipeline(pipelineId), Math.max(0, lastPipelineMessageId(pipelineId) - 1))
    : runFeed(run, Math.max(0, lastMessageId(runId) - 1));
  return live.feed.at(-1)?.trim() ?? `${runLabel(run)}: ${run?.status ?? 'running'}`;
}

server.tool('resume', {
  description: 'Continue a run in its own agent session and branch, as a new run id. On a "waiting" run, input is ' +
    'the developer\'s answer to its question; on a finished run, a follow-up instruction.',
  input: { run_id: RUN_ID, input: str({ required: true }) },
}, async ({ run_id, input }) => attempt(() => resumeRun(run_id, input, { answering: getRun(run_id)?.status === 'waiting' })));

server.tool('cancel', {
  description: 'Stop a queued or running run.',
  input: { run_id: RUN_ID },
}, async ({ run_id }) => attempt(() => (isPipelineId(run_id) ? cancelPipeline(run_id) : cancelRun(run_id))));

server.tool('update', {
  description: 'Merge the current branch into a run\'s branch (when it is behind or merge conflicts). On conflicts ' +
    'the run\'s agent resolves them as a new run, unless resolve is false.',
  input: { run_id: RUN_ID, resolve: bool({ default: true }) },
}, async ({ run_id, resolve: res }) => attempt(() => syncBranch(run_id, { resolve: res })));

const STAGE = obj(OVERRIDES);
server.tool('pipeline', {
  description: 'Run plan -> execute -> review by itself, with fix rounds when review requests changes or verify ' +
    'fails. Stops before merge. Returns a pipeline_id for status / cancel.',
  input: { task: str({ required: true, description: 'Include the developer\'s answers to open questions' }),
    verify: str({ description: 'Command to run after each write step, e.g. "npm test"' }),
    max_fix_rounds: int({ min: 0, max: 5, default: 1 }), context_runs: CONTEXT_RUNS, cwd: CWD,
    plan: STAGE, execute: STAGE, review: STAGE, session: SESSION },
}, async ({ task, verify, max_fix_rounds, context_runs, cwd, plan, execute, review, session }) => attempt(() =>
  startPipeline({ task, verify, max_fix_rounds, context_runs, cwd, session, overrides: { plan, execute, review } })));

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
    'pipelines, and totals per tentacle/agent/model (outcomes, tokens, cost, duration, tool calls, diff size).',
  input: { session: SESSION },
}, async ({ session }) => text(sessionSummary(session)));

// ---- settings ----

server.tool('tentacles', {
  description: 'Tentacles in this repo with resolved settings and where each comes from; installed agents and the ' +
    'tentacles that need them; limits.',
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
  return text({ repo: list[0]?.repo, tentacles: list, agents: agents.agents,
    agent_problems: agents.problems.length ? agents.problems : undefined,
    limits: { max_parallel: maxParallel(),
      approval_mode: approvalMode() },
    user_files: { dir: userDir(), problems: userTentacles().problems.length ? userTentacles().problems : undefined } });
});

server.start();
