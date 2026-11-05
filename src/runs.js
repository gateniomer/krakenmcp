// Runs: create/start a tentacle run, and the views over runs (status, stats).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveAgent, AGENTS } from './agents.js';
import {
  PLANS_DIR, LOGS_DIR, WORKTREES_DIR, IN_PROGRESS, newId, insertRun, getRun, recentMessages, allRuns, latestReview,
  listRuns, listPipelines, db,
} from './store.js';
import { pump, queueInfo, checkBudget } from './scheduler.js';
import { reviewInput, gitIn } from './branches.js';
import { resolveTentacle, renderPrompt, formatContext, knownNames } from './tentacles.js';

export function isGitRepo(dir) {
  try { execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export const clip = (s, n = 1500) => (s && s.length > n ? `${s.slice(0, n)}\n…[truncated, ${s.length} chars]` : s);
const parse = (s) => (s ? JSON.parse(s) : undefined);
// Older rows used SQLite datetime('now') ("YYYY-MM-DD HH:MM:SS", UTC without a zone marker).
const toDate = (s) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
const ms = (a, b) => (a && b ? toDate(b) - toDate(a) : undefined);

// Metrics an agent's output does not contain, so they read "not reported" instead of zero.
export function notReported(agent) {
  const r = AGENTS[agent]?.reports;
  return r ? Object.entries(r).filter(([, v]) => !v).map(([k]) => k) : [];
}

export function metrics(run) {
  const end = run.finished_at ?? (run.started_at ? new Date().toISOString() : null);
  const missing = notReported(run.agent);
  return {
    not_reported: missing.length ? missing : undefined,
    queue_ms: ms(run.created_at, run.started_at),
    duration_ms: run.duration_ms ?? ms(run.started_at, end), // live elapsed while running
    tokens: parse(run.tokens),
    cost_usd: run.cost_usd ?? undefined,
    steps: run.steps ?? undefined,
    tool_calls: parse(run.tool_calls),
    diff: parse(run.diff_stat),
    exit_code: run.exit_code ?? undefined,
  };
}

export function describe(run, full = false) {
  const resultFile = join(PLANS_DIR, `${run.id}.md`);
  return {
    id: run.id, tentacle: run.tentacle, access: run.access, status: run.status,
    queue: queueInfo(run.id),
    agent: run.agent, model: run.model, effort: run.effort,
    task: clip(run.task, 200), plan_id: run.plan_id ?? undefined,
    question: run.status === 'waiting' ? run.question : undefined,
    next: run.status === 'waiting' ? `ask the developer, then resume("${run.id}", their reply)` : undefined,
    outcome: run.outcome ? `${run.outcome}: ${run.outcome_detail}` : undefined,
    verdict: run.verdict ?? undefined, target_run: run.target_run ?? undefined,
    resumed_from: run.resumed_from ?? undefined,
    reused_session_of: parse(run.config)?.reused_session_of,
    review: run.access === 'write' && run.branch ? latestReview(run.id) ?? undefined : undefined,
    result_file: existsSync(resultFile) ? resultFile : undefined,
    workdir: run.workdir, branch: run.branch ?? undefined,
    result: full ? run.result : clip(run.result),
    error: run.error ?? undefined,
    stopped: run.stop_reason ?? undefined,
    pipeline: run.pipeline_id ?? undefined,
    metrics: metrics(run),
    verify: run.verify_cmd
      ? { cmd: run.verify_cmd, exit: run.verify_exit, output: full ? run.verify_output : clip(run.verify_output, 600) }
      : undefined,
    log: join(LOGS_DIR, `${run.id}.log`),
    recent_messages: recentMessages(run.id),
  };
}

// Create and start a run of any tentacle.
export function startRun(name, { input, plan_id, context_runs = [], target_run, cwd, session, overrides, pipeline_id }) {
  checkBudget();
  let planRun = null;
  if (plan_id) {
    planRun = getRun(plan_id);
    if (!planRun) throw new Error(`no run with id ${plan_id}`);
    if (planRun.status !== 'done' || !planRun.result) throw new Error(`run ${plan_id} is ${planRun.status}; it must be done with a result`);
  }
  const contextRuns = context_runs.map((cid) => {
    const r = getRun(cid);
    if (!r) throw new Error(`no run with id ${cid} (context_runs)`);
    if (r.status !== 'done' || !r.result) throw new Error(`context run ${cid} is ${r.status}; it must be done with a result`);
    return r;
  });
  const targetRun = target_run ? getRun(target_run) : null;
  if (target_run && !targetRun) throw new Error(`no run with id ${target_run}`);
  let dir = resolve(cwd ?? targetRun?.cwd ?? planRun?.cwd ?? contextRuns[0]?.cwd ?? process.cwd());
  if (!existsSync(dir)) throw new Error(`cwd does not exist: ${dir}`);

  const t = resolveTentacle(name, dir, overrides);
  const s = t.settings;
  resolveAgent(s.agent); // fails early if the agent is not installed
  const limits = { max_cost_usd: s.max_cost_usd ?? undefined, max_tokens: s.max_tokens ?? undefined };
  const reports = AGENTS[s.agent].reports;
  const warnings = [
    limits.max_cost_usd && !reports.cost ? `${s.agent} does not report cost, so max_cost_usd cannot be enforced` : null,
    limits.max_tokens && !reports.tokens ? `${s.agent} does not report tokens, so max_tokens cannot be enforced` : null,
  ].filter(Boolean);
  if (t.needs_plan && !planRun) throw new Error(`tentacle "${name}" needs plan_id (its prompt uses {{plan}})`);

  // Tentacles whose prompt uses {{diff}} (review): the target run's changes, or uncommitted changes.
  let diff = null, readDir = dir;
  if (t.needs_diff) {
    if (s.access !== 'read') throw new Error(`tentacle "${name}" uses {{diff}} and must have read access`);
    const ri = reviewInput(target_run, dir);
    diff = ri.diff; readDir = ri.workdir; dir = ri.cwd;
    if (ri.planId && !contextRuns.some((r) => r.id === ri.planId)) {
      const pr = getRun(ri.planId); if (pr?.result) contextRuns.unshift(pr);
    }
  } else if (target_run) throw new Error(`tentacle "${name}" does not take run_id (only tentacles using {{diff}})`);
  const task = input ?? targetRun?.task ?? planRun?.task
    ?? (t.needs_diff ? 'Review the uncommitted changes in this repository.' : undefined);
  if (!task) throw new Error('input is required');

  const warm = warmSession(name, t, { dir, session, hasContext: contextRuns.length > 0 });
  const id = newId(name.slice(0, 8));
  let workdir = readDir, branch = null, base_sha = null;
  if (s.access === 'write' && s.isolation === 'worktree') {
    if (!isGitRepo(dir)) throw new Error(`${dir} is not a git repo; set isolation "none" for this tentacle`);
    workdir = join(WORKTREES_DIR, id);
    branch = `kraken/${id}`;
    base_sha = gitIn(dir, 'rev-parse', 'HEAD');
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-b', branch, workdir, base_sha], { stdio: 'ignore' });
  }
  const prompt = renderPrompt(t, { task, plan: planRun?.result, context: formatContext(contextRuns), diff, workdir, repo: t.repo });
  insertRun({
    id, session, tentacle: name, access: s.access, plan_id: planRun?.id, task, agent: s.agent, model: s.model,
    effort: s.effort, prompt,
    config: { settings: { ...s, prompt: undefined }, sources: t.sources, context_runs: contextRuns.map((r) => r.id), limits,
      reused_session_of: warm?.id },
    timeout_min: s.timeout_min, cwd: dir, workdir, branch, verify_cmd: s.access === 'write' ? s.verify : null,
    base_sha, target_run: targetRun?.id, pipeline_id, native_session: warm?.native_session,
  });
  pump();
  return {
    run_id: id, tentacle: name, status: getRun(id).status, queue: queueInfo(id), agent: s.agent, model: s.model, effort: s.effort ?? undefined,
    workdir, branch: branch ?? undefined, verify: s.access === 'write' ? s.verify ?? undefined : undefined,
    next: `call status with run_id "${id}" and wait_seconds 50`,
    limits: limits.max_cost_usd || limits.max_tokens ? limits : undefined,
    warnings: warnings.length ? warnings : undefined,
    note: branch ? 'Uncommitted changes in the main checkout are NOT in the worktree.' : undefined,
    reused_session_of: warm?.id,
  };
}

// Token saver: a read tentacle with reuse_session_min continues the agent session of the same
// tentacle's last run (same session label, repo, agent, model, effort) if that finished within the
// window. The agent keeps what it already read, and providers' prompt caches (often ~5 minutes)
// make the shared history cheap. Not for review ({{diff}}: each review starts unbiased) or write runs
// (each has its own worktree), and not when context_runs are passed in.
export function warmSession(name, t, { dir, session, hasContext }) {
  const s = t.settings, mins = s.reuse_session_min;
  if (!(mins > 0) || s.access !== 'read' || t.needs_diff || hasContext) return null;
  const since = new Date(Date.now() - mins * 60_000).toISOString();
  return db.prepare(`SELECT id, native_session FROM runs WHERE tentacle = ? AND session = ? AND cwd = ? AND agent = ?
      AND model IS ? AND effort IS ? AND status = 'done' AND native_session IS NOT NULL AND finished_at > ?
      ORDER BY finished_at DESC LIMIT 1`).get(name, session, dir, s.agent, s.model ?? null, s.effort ?? null, since) ?? null;
}


// Totals per tentacle | agent | model in a session.
export function sessionStats(session) {
  const groups = new Map();
  for (const r of allRuns(session)) {
    const key = `${r.tentacle} | ${r.agent} | ${r.model ?? 'default'}${r.effort ? `#${r.effort}` : ''}`;
    const g = groups.get(key) ?? { group: key, runs: 0, done: 0, failed: 0, verify_failed: 0, timeout: 0, cancelled: 0,
      waiting: 0, answered: 0, over_budget: 0, in_progress: 0, merged: 0, discarded: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0,
      total_duration_ms: 0, timed_runs: 0, tool_calls: 0, failed_tool_calls: 0, files_changed: 0, insertions: 0, deletions: 0 };
    g.runs++;
    if (IN_PROGRESS.includes(r.status)) g.in_progress++; else g[r.status] = (g[r.status] ?? 0) + 1;
    if (r.outcome) g[r.outcome]++;
    const t = parse(r.tokens) ?? {};
    for (const k of Object.keys(g.tokens)) g.tokens[k] += t[k] || 0;
    g.cost_usd += r.cost_usd || 0;
    if (r.duration_ms != null) { g.total_duration_ms += r.duration_ms; g.timed_runs++; }
    const tc = parse(r.tool_calls); if (tc) { g.tool_calls += tc.total; g.failed_tool_calls += tc.failed; }
    const d = parse(r.diff_stat); if (d) { g.files_changed += d.files; g.insertions += d.insertions; g.deletions += d.deletions; }
    g.not_reported ??= notReported(r.agent);
    groups.set(key, g);
  }
  const rows = [...groups.values()].map(({ timed_runs, ...g }) => ({
    ...g, avg_duration_ms: timed_runs ? Math.round(g.total_duration_ms / timed_runs) : null,
    not_reported: g.not_reported.length ? g.not_reported : undefined,
  }));
  const partial = rows.filter((g) => g.not_reported).map((g) => `${g.group}: no ${g.not_reported.join('/')}`);
  const total = rows.reduce((a, g) => ({
    runs: a.runs + g.runs, cost_usd: a.cost_usd + g.cost_usd, total_duration_ms: a.total_duration_ms + g.total_duration_ms,
    tokens: Object.fromEntries(Object.keys(g.tokens).map((k) => [k, (a.tokens[k] || 0) + g.tokens[k]])),
  }), { runs: 0, cost_usd: 0, total_duration_ms: 0, tokens: {} });
  return { session, groups: rows, total,
    note: 'Runs from before metrics were added have no duration/cost/tool-call data.' +
      (partial.length ? ` Totals leave out what these agents do not report: ${partial.join('; ')}.` : '') };
}

// The `session` tool: what needs the developer now, recent history, and totals.
export function sessionSummary(session) {
  const all = allRuns(session);
  const ids = (pred) => all.filter(pred).map((r) => r.id);
  const stats = sessionStats(session);
  const pipelines = listPipelines(session);
  return {
    session,
    attention: {
      in_progress: ids((r) => IN_PROGRESS.includes(r.status)),
      waiting: ids((r) => r.status === 'waiting'),
      // newest run per branch: a resumed run continues the same branch
      ready_to_merge: [...new Map(all.filter((r) => r.branch).map((r) => [r.branch, r])).values()]
        .filter((r) => !r.outcome && ['done', 'verify_failed'].includes(r.status)).map((r) => r.id),
    },
    total: stats.total,
    groups: stats.groups,
    runs: listRuns(session),
    pipelines: pipelines.length ? pipelines : undefined,
    note: stats.note,
  };
}

// Agent check plus which tentacles in this repo depend on each agent.
export function agentReport(dir, check) {
  const usedBy = {};
  for (const n of knownNames(dir)) {
    try { const a = resolveTentacle(n, dir).settings.agent; (usedBy[a] ??= []).push(n); } catch { /* broken custom tentacle */ }
  }
  const agents = check().map((a) => ({ ...a, used_by: usedBy[a.name] ?? [] }));
  const blocked = agents.filter((a) => !a.installed && a.used_by.length)
    .map((a) => `${a.used_by.join(', ')} use ${a.name}, which is not installed`);
  return { agents, problems: blocked, note: 'Login is not checked; a missing login shows up as a failed run.' };
}
