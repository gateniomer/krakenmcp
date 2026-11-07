// Creating and starting a run of any tentacle.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveAgent, AGENTS } from './agents.js';
import { WORKTREES_DIR, newId, insertRun, getRun } from './store.js';
import { pump, queueInfo, firstStatus } from './scheduler.js';
import { reviewInput } from './branches.js';
import { gitIn, isGitRepo } from './git.js';
import { resolveTentacle, renderPrompt, formatContext } from './tentacles.js';
import { startCard } from './feed.js';
import { fail } from './util.js';

// Create and start a run of any tentacle.
// Chain stages pass chain_id / chain_stage, their stage settings as layers, and the developer's note.
export function startRun(name, { input, plan_id, context_runs = [], target_run, cwd, session, overrides,
  chain_id, chain_stage, layers = [], note }) {
  let planRun = null;
  if (plan_id) {
    planRun = getRun(plan_id);
    if (!planRun) fail(`no run with id ${plan_id}`);
    if (planRun.status !== 'done' || !planRun.result) {
      fail(`run ${plan_id} is ${planRun.status}; it must be done with a result`);
    }
  }
  const contextRuns = context_runs.map((cid) => {
    const r = getRun(cid);
    if (!r) fail(`no run with id ${cid} (context_runs)`);
    if (r.status !== 'done' || !r.result) {
      fail(`context run ${cid} is ${r.status}; it must be done with a result`);
    }
    return r;
  });
  const targetRun = target_run ? getRun(target_run) : null;
  if (target_run && !targetRun) fail(`no run with id ${target_run}`);
  let dir = resolve(cwd ?? targetRun?.cwd ?? planRun?.cwd ?? contextRuns[0]?.cwd ?? process.cwd());
  if (!existsSync(dir)) fail(`cwd does not exist: ${dir}`);

  const t = resolveTentacle(name, dir, overrides, layers);
  const s = t.settings;
  resolveAgent(s.agent); // fails early if the agent is not installed
  const limits = { max_cost_usd: s.max_cost_usd ?? undefined, max_tokens: s.max_tokens ?? undefined };
  const reports = AGENTS[s.agent].reports;
  const warnings = [
    limits.max_cost_usd && !reports.cost
      ? `${s.agent} does not report cost, so max_cost_usd cannot be enforced` : null,
    limits.max_tokens && !reports.tokens
      ? `${s.agent} does not report tokens, so max_tokens cannot be enforced` : null,
  ].filter(Boolean);
  if (t.needs_plan && !planRun) fail(`tentacle "${name}" needs plan_id (its prompt uses {{plan}})`);

  // Tentacles whose prompt uses {{diff}} (review): the target run's changes, or uncommitted changes.
  let diff = null, readDir = dir;
  if (t.needs_diff) {
    if (s.access !== 'read') fail(`tentacle "${name}" uses {{diff}} and must have read access`);
    const ri = reviewInput(target_run, dir);
    diff = ri.diff; readDir = ri.workdir; dir = ri.cwd;
    if (ri.planId && !contextRuns.some((r) => r.id === ri.planId)) {
      const pr = getRun(ri.planId); if (pr?.result) contextRuns.unshift(pr);
    }
  } else if (target_run) fail(`tentacle "${name}" does not take run_id (only tentacles using {{diff}})`);
  const task = input ?? targetRun?.task ?? planRun?.task
    ?? (t.needs_diff ? 'Review the uncommitted changes in this repository.' : undefined);
  if (!task) fail('input is required');

  const id = newId(name.slice(0, 8));
  let workdir = readDir, branch = null, base_sha = null;
  if (s.access === 'write') {
    if (!isGitRepo(dir)) fail(`${dir} is not a git repo; write tentacles work on a branch in a git worktree`);
    workdir = join(WORKTREES_DIR, id);
    branch = `kraken/${id}`;
    base_sha = gitIn(dir, 'rev-parse', 'HEAD');
    gitIn(dir, 'worktree', 'add', '-b', branch, workdir, base_sha);
  }
  const context = formatContext(contextRuns);
  let prompt = renderPrompt(t, { task, plan: planRun?.result, context, diff, workdir, repo: t.repo });
  if (note) prompt += `\n\nDeveloper note for this step: ${note}`;
  insertRun({
    id, session, tentacle: name, access: s.access, plan_id: planRun?.id, task, agent: s.agent, model: s.model,
    effort: s.effort, prompt,
    config: { settings: { ...s, prompt: undefined }, sources: t.sources,
      context_runs: contextRuns.map((r) => r.id), limits, needs_diff: t.needs_diff || undefined },
    timeout_min: s.timeout_min, cwd: dir, workdir, branch, verify_cmd: s.access === 'write' ? s.verify : null,
    base_sha, target_run: targetRun?.id, chain_id, chain_stage,
  });
  pump();
  return {
    card: startCard(getRun(id)),
    run_id: id, tentacle: name, status: getRun(id).status, queue: queueInfo(id),
    agent: s.agent, model: s.model, effort: s.effort ?? undefined,
    workdir, branch: branch ?? undefined, verify: s.access === 'write' ? s.verify ?? undefined : undefined,
    next: firstStatus(id),
    limits: limits.max_cost_usd || limits.max_tokens ? limits : undefined,
    warnings: warnings.length ? warnings : undefined,
    note: branch ? 'Uncommitted changes in the main checkout are NOT in the worktree.' : undefined,
  };
}
