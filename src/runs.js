// Runs: create/start a tentacle run, and the views over runs (status, stats).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveAgent, AGENTS } from './agents.js';
import {
  PLANS_DIR, LOGS_DIR, WORKTREES_DIR, IN_PROGRESS, newId, insertRun, getRun, recentMessages, messagesSince,
  messagesSinceAll, lastMessageId, allRuns, latestReview, listRuns, listPipelines, toolMessages, db,
} from './store.js';
import { pump, queueInfo } from './scheduler.js';
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

// A run that ended badly must not be retried silently on another agent or model.
export const STOP_NEXT = 'stop: report this error to the developer and ask how to proceed; ' +
  'do not retry or switch agent/model on your own';
const STOP = ['failed', 'timeout', 'over_budget'];

export function describe(run, full = false) {
  const resultFile = join(PLANS_DIR, `${run.id}.md`);
  return {
    id: run.id, tentacle: run.tentacle, access: run.access, status: run.status,
    queue: queueInfo(run.id),
    agent: run.agent, model: run.model, effort: run.effort,
    task: clip(run.task, 200), plan_id: run.plan_id ?? undefined,
    question: run.status === 'waiting' ? run.question : undefined,
    next: run.status === 'waiting' ? `ask the developer, then resume("${run.id}", their reply)`
      : STOP.includes(run.status) ? STOP_NEXT : undefined,
    outcome: run.outcome ? `${run.outcome}: ${run.outcome_detail}` : undefined,
    verdict: run.verdict ?? undefined, target_run: run.target_run ?? undefined,
    resumed_from: run.resumed_from ?? undefined,
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
    cursor: lastMessageId(run.id),
  };
}

// ---- live feed: progress messages rendered as lines the head shows to the developer ----

export const FEED_MAX_LINES = 12;
const squash = (s, n = 200) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// The model a run uses; falls back to the agent's default for that access.
export function modelOf(run) {
  return run.model ?? AGENTS[run.agent]?.defaultModel?.[run.access === 'read' ? 'plan' : 'execute'] ?? 'default';
}

// "plan tentacle (claude opus)"; the model falls back to the agent's default for that access.
export function runLabel(run, stage) {
  return `${stage ? `${stage} › ` : ''}${run.tentacle} tentacle (${run.agent} ${modelOf(run)})`;
}

// rows: messages in id order; labelOf(run_id) gives each run's label. Returns the lines to show
// (the newest FEED_MAX_LINES, with a marker first when older ones were dropped).
export function renderFeed(rows, labelOf, showId = '<id>') {
  const lines = [];
  let prevRun = null, group = null; // group: the open run of tool calls
  for (const m of rows) {
    const label = labelOf(m.run_id);
    if (m.kind === 'progress' && m.body.startsWith('tool: ')) {
      if (!group || group.run !== m.run_id) {
        group = { run: m.run_id, attach: prevRun === m.run_id, label, counts: new Map(), index: lines.length };
        lines.push('');
      }
      const name = m.body.slice(6).trim();
      group.counts.set(name, (group.counts.get(name) ?? 0) + 1);
      const list = [...group.counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
      lines[group.index] = group.attach ? `  · tools: ${list}` : `${label} · tools: ${list}`;
    } else {
      group = null;
      const fromKraken = m.sender === 'kraken';
      const lifecycle = fromKraken && m.kind === 'progress' && /^(started|resumed)\b/.exec(m.body);
      if (m.kind === 'answer') lines.push(`developer: ANSWER: ${squash(m.body, 400)}`);
      else if (lifecycle) lines.push(`${label}: ${lifecycle[0]}`);
      else if (m.kind === 'progress' && !fromKraken) lines.push(`${label}: "${squash(m.body)}"`);
      else if (m.kind === 'question') lines.push(`${label}: QUESTION: ${squash(m.body, 400)}`);
      else lines.push(`${label}: ${squash(m.body)}`);
    }
    prevRun = m.run_id;
  }
  if (lines.length <= FEED_MAX_LINES) return lines;
  return [`(+${lines.length - FEED_MAX_LINES} earlier lines; full log: krakenmcp show ${showId})`, ...lines.slice(-FEED_MAX_LINES)];
}

export function runFeed(run, since = 0, all = false) {
  const rows = all ? messagesSinceAll(run.id, since) : messagesSince(run.id, since);
  const label = runLabel(run);
  return { feed: renderFeed(rows, () => label, run.id), cursor: rows.length ? rows.at(-1).id : Math.max(since, lastMessageId(run.id)) };
}

// ---- live summary: the headline the head shows above the feed, plus the state it writes
// "So far / Now" from. Rendering the sentence is the head's job (it knows the task); Kraken
// only supplies facts, so the summary is deterministic and costs no extra model call. ----

const STATUS_GLYPH = {
  queued: '○', running: '●', waiting: '◐', done: '✓', failed: '✕', cancelled: '⊘',
  timeout: '✕', over_budget: '✕', verify_failed: '✕',
};

export function elapsedText(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function toolCounts(rows) {
  const by = new Map();
  for (const m of rows) {
    const name = m.body.slice(6).trim() || 'unknown';
    by.set(name, (by.get(name) ?? 0) + 1);
  }
  return { total: [...by.values()].reduce((a, b) => a + b, 0), by_name: Object.fromEntries(by) };
}

// The newest thing the agent said or did, for the headline's last column.
export function currentActivity(rows, status) {
  if (status === 'waiting') return 'question for the developer';
  const last = rows.at(-1);
  if (!last) return status === 'queued' ? 'queued' : 'starting';
  if (last.kind === 'question') return 'question for the developer';
  const body = last.body ?? '';
  if (last.kind === 'progress') {
    if (body.startsWith('tool: ')) return `using ${body.slice(6).trim()}`;
    const lifecycle = /^(started|resumed)\b/.exec(body);
    if (lifecycle && last.sender === 'kraken') return lifecycle[0];
  }
  return squash(body, 40) || status;
}

// Pad to a column width, but never let a full column touch the next one.
const column = (s, width) => (s.length >= width ? `${s} ` : s.padEnd(width));

export function headline(identity, status, elapsedMs, tools, current) {
  const stat = column(`${STATUS_GLYPH[status] ?? '●'} ${status}`, 11);
  const time = column(elapsedText(elapsedMs), 7);
  const count = tools?.total ? `${tools.total} tool${tools.total === 1 ? '' : 's'}` : '—';
  return `[ 🦑 ${identity} ]  ${stat}${time}${count}${current ? `   ${current}` : ''}`;
}

// The latest line the agent itself wrote (not a tool line, not Kraken's own messages).
export function lastAgentText(rows) {
  const last = [...rows].reverse().find((x) => x.kind === 'progress'
    && x.sender !== 'kraken' && !(x.body ?? '').startsWith('tool: '));
  return last ? squash(last.body, 200) : undefined;
}

export function runSummary(run, stage) {
  const rows = recentMessages(run.id, 50);
  const tools = toolCounts(toolMessages(run.id));
  const m = metrics(run);
  const current = currentActivity(rows, run.status);
  const identity = `${run.tentacle} › ${run.agent} ${modelOf(run)}`;
  return {
    kind: 'run',
    headline: headline(identity, run.status, m.duration_ms, tools, current),
    key: headline(identity, run.status, undefined, tools, current), // no time: progress-notification dedupe
    stage: stage ?? undefined,
    tentacle: run.tentacle, agent: run.agent, model: modelOf(run),
    status: run.status,
    elapsed_s: m.duration_ms === undefined ? undefined : Math.round(m.duration_ms / 1000),
    cost_usd: run.cost_usd ?? undefined,
    tools: tools.total ? tools : undefined,
    milestones: {
      plan_id: run.plan_id ?? undefined,
      verify: run.verify_cmd ? { cmd: run.verify_cmd, exit: run.verify_exit ?? undefined } : undefined,
      resumed_from: run.resumed_from ?? undefined,
    },
    last_line: lastAgentText(rows),
    question: run.status === 'waiting' ? run.question : undefined,
  };
}

// Create and start a run of any tentacle.
export function startRun(name, { input, plan_id, context_runs = [], target_run, cwd, session, overrides, pipeline_id }) {
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

  const id = newId(name.slice(0, 8));
  let workdir = readDir, branch = null, base_sha = null;
  if (s.access === 'write') {
    if (!isGitRepo(dir)) throw new Error(`${dir} is not a git repo; write tentacles work on a branch in a git worktree`);
    workdir = join(WORKTREES_DIR, id);
    branch = `kraken/${id}`;
    base_sha = gitIn(dir, 'rev-parse', 'HEAD');
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-b', branch, workdir, base_sha], { stdio: 'ignore' });
  }
  const prompt = renderPrompt(t, { task, plan: planRun?.result, context: formatContext(contextRuns), diff, workdir, repo: t.repo });
  insertRun({
    id, session, tentacle: name, access: s.access, plan_id: planRun?.id, task, agent: s.agent, model: s.model,
    effort: s.effort, prompt,
    config: { settings: { ...s, prompt: undefined }, sources: t.sources, context_runs: contextRuns.map((r) => r.id), limits },
    timeout_min: s.timeout_min, cwd: dir, workdir, branch, verify_cmd: s.access === 'write' ? s.verify : null,
    base_sha, target_run: targetRun?.id, pipeline_id,
  });
  pump();
  return {
    run_id: id, tentacle: name, status: getRun(id).status, queue: queueInfo(id), agent: s.agent, model: s.model, effort: s.effort ?? undefined,
    workdir, branch: branch ?? undefined, verify: s.access === 'write' ? s.verify ?? undefined : undefined,
    next: `call status with run_id "${id}", wait_seconds 50 and since 0`,
    limits: limits.max_cost_usd || limits.max_tokens ? limits : undefined,
    warnings: warnings.length ? warnings : undefined,
    note: branch ? 'Uncommitted changes in the main checkout are NOT in the worktree.' : undefined,
  };
}

// Totals per tentacle | agent | model in a session. Per-run detail is in status.
// failed counts every run that ended badly: failed, verify_failed, timeout, over_budget.
const FAILED = ['failed', 'verify_failed', 'timeout', 'over_budget'];
export function sessionStats(session) {
  const groups = new Map();
  for (const r of allRuns(session)) {
    const key = `${r.tentacle} | ${r.agent} | ${r.model ?? 'default'}${r.effort ? `#${r.effort}` : ''}`;
    const g = groups.get(key) ?? { group: key, runs: 0, done: 0, failed: 0, cost_usd: 0,
      tokens: { input: 0, output: 0 }, total_duration_ms: 0, timed_runs: 0 };
    g.runs++;
    if (r.status === 'done') g.done++;
    if (FAILED.includes(r.status)) g.failed++;
    const t = parse(r.tokens) ?? {};
    g.tokens.input += t.input || 0; g.tokens.output += t.output || 0;
    g.cost_usd += r.cost_usd || 0;
    if (r.duration_ms != null) { g.total_duration_ms += r.duration_ms; g.timed_runs++; }
    g.not_reported ??= notReported(r.agent);
    groups.set(key, g);
  }
  const rows = [...groups.values()].map(({ timed_runs, total_duration_ms, not_reported, ...g }) => ({
    ...g, avg_duration_ms: timed_runs ? Math.round(total_duration_ms / timed_runs) : null,
    not_reported: not_reported.length ? not_reported : undefined,
  }));
  const total = rows.reduce((a, g) => ({
    runs: a.runs + g.runs, cost_usd: a.cost_usd + g.cost_usd,
    tokens: { input: a.tokens.input + g.tokens.input, output: a.tokens.output + g.tokens.output },
  }), { runs: 0, cost_usd: 0, tokens: { input: 0, output: 0 } });
  return { session, groups: rows, total };
}

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
