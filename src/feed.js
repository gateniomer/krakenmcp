// What the head shows the developer while a run goes: feed lines, the live summary and its one-line
// headline (progress notifications), and the cards (card.js draws them).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS } from './agents.js';
import { PLANS_DIR, IN_PROGRESS, recentMessages, messagesSince, messagesSinceAll, lastMessageId,
  toolMessages } from './store.js';
import { queueInfo } from './scheduler.js';
import { metrics, nextOf } from './view.js';
import { parseJson } from './util.js';
import { box, tildify } from './card.js';

// ---- live feed: progress messages rendered as lines the head shows to the developer ----

export const FEED_MAX_LINES = 12;
const squash = (s, n = 200) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// The model a run uses; falls back to the agent's default for that access.
export function modelOf(run) {
  return run.model ?? AGENTS[run.agent]?.defaultModel?.[run.access] ?? 'default';
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
        group = { run: m.run_id, attach: prevRun === m.run_id, label, counts: new Map(),
          index: lines.length };
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
  const dropped = `(+${lines.length - FEED_MAX_LINES} earlier lines; full log: krakenmcp show ${showId})`;
  return [dropped, ...lines.slice(-FEED_MAX_LINES)];
}

export function runFeed(run, since = 0, all = false) {
  const rows = all ? messagesSinceAll(run.id, since) : messagesSince(run.id, since);
  const label = runLabel(run);
  const cursor = rows.length ? rows.at(-1).id : Math.max(since, lastMessageId(run.id));
  return { feed: renderFeed(rows, () => label, run.id), cursor };
}

// ---- live summary: the facts behind the cards and the one-line headline progress notifications
// use. Kraken
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
    now: current,
    last_line: lastAgentText(rows),
    question: run.status === 'waiting' ? run.question : undefined,
  };
}

// ---- cards: the bordered boxes the head shows as-is (see card.js) ----

export const statusText = (status) => `${STATUS_GLYPH[status] ?? '●'} ${status}`;
export const runTitle = (run) => `🦑 ${run.tentacle} › ${run.agent} ${String(modelOf(run)).split('/').at(-1)}`;
const money = (usd) => (usd ? `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}` : null);
const toolText = (tools) => (tools?.total ? `${tools.total} tool${tools.total === 1 ? '' : 's'}` : null);
export const timeLine = (ms, usd, tools, extra = []) =>
  [elapsedText(ms), money(usd), toolText(tools), ...extra].filter(Boolean).join(' · ');
const firstLine = (s) => (s ?? '').split('\n').find((l) => l.trim()) ?? '';

// The card for a run that was just started or resumed: what the head called, on which agent.
export function startCard(run) {
  const q = queueInfo(run.id);
  return box(runTitle(run), q ? `○ queued (${q.ahead} ahead)` : statusText(run.status), [
    ['run', run.resumed_from ? `${run.id} (resumes ${run.resumed_from})` : run.id],
    ['task', firstLine(run.task)],
    ['target', run.target_run],
    ['branch', run.branch],
    ['verify', run.verify_cmd],
  ]);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const diffText = (d) => (d ? `${plural(d.files, 'file')}, +${d.insertions} −${d.deletions}` : null);

// The card for a run in progress (what it is doing now) or finished (its result and the next step).
// Built from the run's summary, so a status reply reads the messages once.
export function runCard(run, sum = runSummary(run)) {
  const time = timeLine(sum.elapsed_s * 1000, sum.cost_usd, sum.tools);
  if (IN_PROGRESS.includes(run.status)) {
    const said = sum.last_line && !sum.last_line.startsWith(sum.now.replace(/…$/, '')) ? sum.last_line : null;
    const rows = [['run', run.id], ['time', time], ['now', sum.now], ['said', said, 2]];
    return box(runTitle(run), statusText(run.status), rows);
  }
  const file = join(PLANS_DIR, `${run.id}.md`);
  const diff = diffText(parseJson(run.diff_stat));
  return box(runTitle(run), statusText(run.status), [
    ['run', run.id],
    ['took', time],
    ['question', run.status === 'waiting' ? run.question : null, 3],
    ['error', run.error ? firstLine(run.error) : run.stop_reason, 2],
    ['verdict', run.verdict],
    ['branch', run.branch ? `${run.branch}${diff ? ` (${diff})` : ''}` : null],
    ['verify', run.verify_cmd ? `${run.verify_cmd} → exit ${run.verify_exit ?? '?'}` : null],
    ['outcome', run.outcome ? `${run.outcome}: ${run.outcome_detail}` : null],
    ['result', existsSync(file) ? tildify(file) : null, 2],
    ['next', nextOf(run).next, 3],
  ]);
}

