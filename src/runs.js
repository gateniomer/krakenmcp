// Creating and starting a run of any tentacle.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveAgent, AGENTS } from './agents.js';
import { WORKTREES_DIR, IN_PROGRESS, newId, insertRun, getRun } from './store.js';
import { pump, queueInfo, firstStatus } from './scheduler.js';
import { reviewInput } from './branches.js';
import { gitIn, isGitRepo, repoRoot } from './git.js';
import { resolveTentacle, renderPrompt, formatContext } from './tentacles.js';
import { readPlanFile, splitStages } from './plans.js';
import { startCard } from './feed.js';
import { fail } from './util.js';

// Create and start a run of any tentacle.
// Chain stages pass chain_id / chain_stage, their stage settings as layers, and the developer's note.
// plan_file (+ section): a plan kept in the repository, used as {{plan}} instead of a plan run.
export function startRun(name, { input, plan_id, plan_file, section, context_runs = [], target_run, cwd,
  session, overrides, base, continue_run,
  chain_id, chain_stage, layers = [], note }) {
  let planRun = null;
  if (plan_id && plan_file) fail('pass plan_id or plan_file, not both');
  if (section && !plan_file) fail('section needs plan_file');
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
  let planText = planRun?.result, stagedText = planRun?.result, planLabel = null;
  if (plan_file) {
    const pf = readPlanFile(repoRoot(dir), dir, plan_file, section);
    planText = pf.plan; stagedText = pf.staged_text; planLabel = pf.label;
  }
  if (t.needs_plan && !planText) {
    fail(`tentacle "${name}" needs plan_id or plan_file (its prompt uses {{plan}})`);
  }

  // Tentacles whose prompt uses {{diff}} (review): the target run's changes, or uncommitted changes.
  let diff = null, readDir = dir;
  if (t.needs_diff) {
    if (s.access !== 'read') fail(`tentacle "${name}" uses {{diff}} and must have read access`);
    const ri = reviewInput(target_run, dir, base);
    diff = ri.diff; readDir = ri.workdir; dir = ri.cwd;
    if (ri.planId && !contextRuns.some((r) => r.id === ri.planId)) {
      const pr = getRun(ri.planId); if (pr?.result) contextRuns.unshift(pr);
    }
  } else if (target_run) fail(`tentacle "${name}" does not take run_id (only tentacles using {{diff}})`);
  else if (base) fail(`tentacle "${name}" does not take base (only tentacles using {{diff}})`);
  // continue_run: a later stage on an earlier write run's branch, in a fresh agent session.
  let prevRun = null;
  if (continue_run) {
    if (s.access !== 'write') fail(`tentacle "${name}" does not take continue_run (write tentacles only)`);
    prevRun = getRun(continue_run);
    if (!prevRun) fail(`no run with id ${continue_run}`);
    if (prevRun.access !== 'write' || !prevRun.branch) {
      fail(`${continue_run} is not a write run with a branch`);
    }
    if (IN_PROGRESS.includes(prevRun.status)) fail(`${continue_run} is still ${prevRun.status}`);
    if (prevRun.outcome === 'merged' || prevRun.outcome === 'discarded') {
      fail(`${continue_run} was already ${prevRun.outcome}; start a new execute instead`);
    }
    if (!existsSync(prevRun.workdir)) fail(`${continue_run}'s worktree is gone`);
    const dirty = gitIn(prevRun.workdir, 'status', '--porcelain');
    if (dirty) {
      fail(`${continue_run}'s worktree has uncommitted changes; commit or resume it first:\n${dirty}`);
    }
    dir = prevRun.cwd;
  }
  const task = input ?? targetRun?.task ?? planRun?.task ?? (planLabel && `Implement ${planLabel}`)
    ?? (t.needs_diff ? (base ? `Review the changes in this repository since ${base}.`
      : 'Review the uncommitted changes in this repository.') : undefined);
  if (!task) fail('input is required');

  const id = newId(name.slice(0, 8));
  let workdir = readDir, branch = null, base_sha = null;
  if (s.access === 'write' && prevRun) {
    // Same branch and worktree, same base: a later review or merge covers every stage.
    workdir = prevRun.workdir;
    branch = prevRun.branch;
    base_sha = prevRun.base_sha;
  } else if (s.access === 'write') {
    if (!isGitRepo(dir)) fail(`${dir} is not a git repo; write tentacles work on a branch in a git worktree`);
    workdir = join(WORKTREES_DIR, id);
    branch = `kraken/${id}`;
    base_sha = gitIn(dir, 'rev-parse', 'HEAD');
    gitIn(dir, 'worktree', 'add', '-b', branch, workdir, base_sha);
  }
  const context = formatContext(contextRuns);
  let prompt = renderPrompt(t, { task, plan: planText, context, diff, workdir, repo: t.repo });
  if (note) prompt += `\n\nDeveloper note for this step: ${note}`;
  // Staged runs: one fresh agent session per "Stage" heading of the plan (see worker.js).
  const stages = s.access === 'write' && t.needs_plan && s.stages !== 'off' ? splitStages(stagedText) : [];
  insertRun({
    id, session, tentacle: name, access: s.access, plan_id: planRun?.id, task, agent: s.agent, model: s.model,
    effort: s.effort, prompt,
    config: { settings: { ...s, prompt: undefined }, sources: t.sources,
      context_runs: contextRuns.map((r) => r.id), limits, needs_diff: t.needs_diff || undefined,
      plan_file: planLabel ?? undefined,
      stages: stages.length ? { titles: stages.map((x) => x.title), next: 0 } : undefined },
    timeout_min: s.timeout_min, cwd: dir, workdir, branch, verify_cmd: s.access === 'write' ? s.verify : null,
    base_sha, target_run: targetRun?.id, chain_id, chain_stage,
  });
  pump();
  return {
    card: startCard(getRun(id)),
    run_id: id, tentacle: name, status: getRun(id).status, queue: queueInfo(id),
    agent: s.agent, model: s.model, effort: s.effort ?? undefined,
    workdir, branch: branch ?? undefined, verify: s.access === 'write' ? s.verify ?? undefined : undefined,
    plan_file: planLabel ?? undefined,
    stages: stages.length ? stages.map((x) => x.title) : undefined,
    next: firstStatus(id),
    limits: limits.max_cost_usd || limits.max_tokens ? limits : undefined,
    warnings: warnings.length ? warnings : undefined,
    note: branch ? 'Uncommitted changes in the main checkout are NOT in the worktree.' : undefined,
  };
}
