// Reports: a session at a glance (totals per tentacle | agent | model, what needs the developer),
// which agents the tentacles depend on, and the resolved settings the tentacles tool shows.
import { IN_PROGRESS, allRuns, listRuns, listChains } from './store.js';
import { notReported, clip } from './view.js';
import { resolveTentacle, knownNames, userDir, userTentacles } from './tentacles.js';
import { knownChains, resolveChain, checkChain, userChainDir, userChains } from './chains.js';
import { agentInfo, checkAgents } from './agents.js';
import { maxParallel, pollSeconds } from './scheduler.js';
import { repoRoot } from './git.js';
import { parseJson as parse } from './util.js';


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
  const chains = listChains(session);
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
    chains: chains.length ? chains : undefined,
  };
}

// Agent check plus which tentacles in this repo depend on each agent.
export function agentReport(dir, check) {
  const usedBy = {};
  for (const n of knownNames(dir)) {
    let agent;
    try { agent = resolveTentacle(n, dir).settings.agent; } catch { continue; } // a broken custom tentacle
    (usedBy[agent] ??= []).push(n);
  }
  const agents = check().map((a) => ({ ...a, used_by: usedBy[a.name] ?? [] }));
  const blocked = agents.filter((a) => !a.installed && a.used_by.length)
    .map((a) => `${a.used_by.join(', ')} use ${a.name}, which is not installed`);
  const note = 'Login is not checked; a missing login shows up as a failed run.';
  return { agents, problems: blocked, note };
}

const orNone = (list) => (list.length ? list : undefined);

function tentacleInfo(name, dir, showPrompts) {
  try {
    const t = resolveTentacle(name, dir);
    const prompt = showPrompts ? t.settings.prompt : clip(t.settings.prompt, 120);
    return { name, builtin: t.builtin, needs_plan: t.needs_plan, user_file: t.user_file,
      settings: { ...t.settings, prompt }, sources: t.sources };
  } catch (e) { return { name, error: e.message }; }
}

function chainInfo(name, dir) {
  try {
    const c = resolveChain(name), k = checkChain(c, dir);
    const stages = k.stages.map(({ tentacle, kind, autonomy, autonomy_source }) =>
      ({ tentacle, kind, autonomy, autonomy_source }));
    return { name, builtin: c.builtin, description: c.description, user_file: c.user_file,
      max_fix_rounds: c.max_fix_rounds, stages, problems: orNone(k.problems) };
  } catch (e) { return { name, error: e.message }; }
}

// What the tentacles tool returns: every tentacle and chain with its settings and their sources,
// the agents (with versions when checkAll), and the limits.
export function settingsReport(dir, { showPrompts = false, checkAll = false } = {}) {
  const tentacles = knownNames(dir).map((n) => tentacleInfo(n, dir, showPrompts));
  const agents = agentReport(dir, checkAll ? checkAgents : agentInfo);
  return {
    repo: repoRoot(dir), tentacles, chains: knownChains().map((n) => chainInfo(n, dir)),
    agents: agents.agents, agent_problems: orNone(agents.problems),
    limits: { max_parallel: maxParallel(), poll_seconds: pollSeconds() },
    user_files: { dir: userDir(), problems: orNone(userTentacles().problems) },
    chain_files: { dir: userChainDir(), problems: orNone(userChains().problems) },
  };
}
