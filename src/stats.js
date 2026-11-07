// Session views: totals per tentacle | agent | model, what needs the developer, and which agents
// the tentacles depend on.
import { IN_PROGRESS, allRuns, listRuns, listChains } from './store.js';
import { notReported } from './view.js';
import { resolveTentacle, knownNames } from './tentacles.js';
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
    try { const a = resolveTentacle(n, dir).settings.agent; (usedBy[a] ??= []).push(n); } catch { /* broken custom tentacle */ }
  }
  const agents = check().map((a) => ({ ...a, used_by: usedBy[a.name] ?? [] }));
  const blocked = agents.filter((a) => !a.installed && a.used_by.length)
    .map((a) => `${a.used_by.join(', ')} use ${a.name}, which is not installed`);
  return { agents, problems: blocked, note: 'Login is not checked; a missing login shows up as a failed run.' };
}
