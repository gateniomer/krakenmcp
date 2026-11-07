// Views of a chain: its status, feed, live summary, card and the full status reply.
import { getRun, latestReview, chainMessagesSince, chainMessagesSinceAll, lastChainMessageId, chainRuns,
  recentMessages, chainToolMessages } from './store.js';
import { describe, STOP_NEXT, finishedNext, runFacts } from './view.js';
import { runLabel, renderFeed, headline, toolCounts, currentActivity, lastAgentText, modelOf, statusText,
  timeLine } from './feed.js';
import { box } from './card.js';
import { parseJson as json, elapsedMs } from './util.js';

export const FINAL = ['done', 'failed', 'cancelled'];

// What a chain is doing right now. Between an answer and the driver's next tick the stored status
// is still "waiting", but the run has been answered: report it as running.
export function chainStatus(c) {
  if (c.status !== 'waiting' || c.pause) return c.status;
  return getRun(c.current_run)?.status === 'waiting' ? 'waiting' : 'running';
}

// Stage labels per run: the tentacle, "fix N" (resumed write runs), "re-review" (later reviews).
function stageNames(c) {
  const stages = json(c.stages, []);
  const names = new Map(), seen = new Map();
  let fixes = 0;
  for (const r of chainRuns(c.id)) {
    const st = stages[r.chain_stage];
    const answering = !!json(r.config, {}).answering;
    if (answering && names.has(r.resumed_from)) { names.set(r.id, names.get(r.resumed_from)); continue; }
    const n = (seen.get(r.chain_stage) ?? 0) + 1;
    seen.set(r.chain_stage, n);
    if (st?.kind === 'write' && r.resumed_from) names.set(r.id, `fix ${++fixes}`);
    else if (st?.kind === 'review' && n > 1) names.set(r.id, 're-review');
    else names.set(r.id, st?.tentacle ?? r.tentacle);
  }
  return names;
}

// The newest run of every stage, by tentacle (for the write stage: the latest fix).
function stageRuns(c) {
  const stages = json(c.stages, []), out = {};
  for (const r of chainRuns(c.id)) { const st = stages[r.chain_stage]; if (st) out[st.tentacle] = r.id; }
  return out;
}

// Feed lines for every run of a chain, one cursor for all of them.
export function chainFeed(c, since = 0, all = false) {
  const rows = all ? chainMessagesSinceAll(c.id, since) : chainMessagesSince(c.id, since, 200);
  const names = stageNames(c), runs = new Map();
  const labelOf = (rid) => {
    if (!runs.has(rid)) {
      const run = getRun(rid);
      runs.set(rid, run ? runLabel(run, names.get(rid)) : 'run');
    }
    return runs.get(rid);
  };
  const showId = c.current_run ?? c.write_run ?? rows.at(-1)?.run_id ?? c.id;
  return { feed: renderFeed(rows, labelOf, showId),
    cursor: rows.length ? rows.at(-1).id : Math.max(since, lastChainMessageId(c.id)) };
}

// The live summary for a chain: the same shape a run returns, aggregated over its stages.
export function chainSummary(c) {
  const status = chainStatus(c);
  const stages = json(c.stages, []);
  const pause = json(c.pause, null);
  const cur = c.current_run ? getRun(c.current_run) : null;
  const tools = toolCounts(chainToolMessages(c.id));
  const rows = cur ? recentMessages(cur.id, 50) : [];
  const elapsed = elapsedMs(c.created_at, c.finished_at);
  const cost = chainRuns(c.id).reduce((a, r) => a + (r.cost_usd ?? 0), 0) || undefined;
  const opts = json(c.options, {});
  const write = c.write_run ? getRun(c.write_run) : null;
  const paused = pause?.reason === 'approval' ? `paused before ${pause.next_stage}` : 'paused: verify failed';
  const current = pause ? paused
    : status === 'waiting' ? 'question for the developer'
      : cur ? `${cur.tentacle} › ${currentActivity(rows, cur.status)}` : (c.stage ?? 'starting');
  const marks = stages.map((st, i) => `${st.tentacle} ${stageMark(c, i, status, pause)}`).join(' → ');
  const identity = `chain ${c.name} › ${marks}`;
  return {
    kind: 'chain',
    headline: headline(identity, status, elapsed, tools, current),
    key: headline(identity, status, undefined, tools, current), // no time: progress-notification dedupe
    stage: c.stage, status,
    tentacle: cur?.tentacle, agent: cur?.agent, model: cur ? modelOf(cur) : undefined,
    elapsed_s: elapsed === undefined ? undefined : Math.round(elapsed / 1000),
    cost_usd: cost, tools: tools.total ? tools : undefined,
    milestones: {
      stages: `${Math.min(c.stage_index + 1, stages.length)} of ${stages.length}`,
      verify: write?.verify_cmd ? { cmd: write.verify_cmd, exit: write.verify_exit ?? undefined } : undefined,
      fix_rounds: `${c.fix_rounds}/${opts.max_fix_rounds}`,
    },
    now: current,
    last_line: lastAgentText(rows),
    question: status === 'waiting' && !pause ? cur?.question : undefined,
  };
}

function chainNext(c, status, cur, pause, stages) {
  if (pause?.reason === 'approval') {
    return `ask: show the ${pause.after} result; ask whether to continue to ${pause.next_stage}; ` +
      `then resume("${c.id}", their reply), or cancel("${c.id}")`;
  }
  if (pause?.reason === 'verify_failed') {
    return `stop: show the verify output; resume("${c.id}", fix instruction), or cancel("${c.id}")`;
  }
  if (status === 'waiting') {
    return `ask: put the question to the developer, then resume("${cur.id}", their reply); ` +
      'the chain continues by itself';
  }
  if (c.status === 'failed') return STOP_NEXT;
  if (c.status === 'cancelled') return 'stop: tell the developer it was cancelled and wait';
  if (c.status !== 'done') return undefined;
  const result = json(c.result, {});
  if (result.merge_commit) return `stop: it landed as ${result.merge_commit}; tell the developer`;
  const write = c.write_run ? getRun(c.write_run) : null;
  if (write && stages.some((s) => s.kind === 'review')) {
    if (write.outcome) return `stop: it was ${write.outcome}; ask the developer what is next`;
    return latestReview(write.id)?.verdict === 'approve'
      ? `ask: show merge("${write.id}") to the developer; merge only after they approve`
      : `ask: show the findings; suggest resume("${write.id}", "address the review findings")`;
  }
  const last = chainRuns(c.id).at(-1);
  return last ? finishedNext(runFacts(getRun(last.id), { chain: false })) : undefined;
}

export function describeChain(c, full = false, live) {
  const opts = json(c.options, {});
  const stages = json(c.stages, []);
  const pause = json(c.pause, null);
  const cur = c.current_run ? getRun(c.current_run) : null;
  const status = chainStatus(c);
  const latest = stageRuns(c);
  return {
    id: c.id, kind: 'chain', name: c.name, status, stage: c.stage,
    stage_index: `${Math.min(c.stage_index + 1, stages.length)} of ${stages.length}`,
    task: c.task.slice(0, 200),
    fix_rounds: `${c.fix_rounds} of ${opts.max_fix_rounds}`,
    stages: stages.map((s) => ({ tentacle: s.tentacle, kind: s.kind, autonomy: s.autonomy,
      run: latest[s.tentacle], status: latest[s.tentacle] && getRun(latest[s.tentacle]).status })),
    runs: latest,
    branch_run: c.write_run ?? undefined,
    current: cur ? describeBrief(cur, full) : undefined,
    question: status === 'waiting' && !pause ? cur?.question : undefined,
    pause: pause ?? undefined,
    result: json(c.result),
    error: c.error ?? undefined,
    ...live,
    cursor: live?.cursor ?? lastChainMessageId(c.id),
    next: chainNext(c, status, cur, pause, stages),
  };
}

// The card for a chain: every stage with a mark (✓ done, ● now, ◐ paused, ✕ failed, · not yet),
// what is happening now, and when it ends its result and the next step.
// The mark of stage i: ✓ done, ● running, ◐ paused or waiting, ✕ failed, ⊘ cancelled, · not yet.
function stageMark(c, i, status, pause) {
  if (i < c.stage_index) return '✓';
  if (i > c.stage_index || pause?.reason === 'approval') return '·';
  if (pause) return '◐';
  return { done: '✓', failed: '✕', cancelled: '⊘' }[c.status] ?? (status === 'waiting' ? '◐' : '●');
}

function pauseText(pause) {
  if (!pause) return null;
  return pause.reason === 'approval' ? `after ${pause.after}; resume to continue to ${pause.next_stage}`
    : `${pause.after} failed verify; resume with a fix instruction, or cancel`;
}

// The card for a chain: every stage with its mark, what is happening now, and when it ends its
// result and the next step. Built from the chain's summary.
export function chainCard(c, sum = chainSummary(c)) {
  const status = chainStatus(c);
  const stages = json(c.stages, []);
  const pause = json(c.pause, null);
  const finished = FINAL.includes(c.status);
  const cur = c.current_run ? getRun(c.current_run) : null;
  const opts = json(c.options, {});
  const write = c.write_run ? getRun(c.write_run) : null;
  const fix = opts.max_fix_rounds ? [`fix ${c.fix_rounds}/${opts.max_fix_rounds}`] : [];
  const badge = pause?.reason === 'approval' ? '◐ paused' : '◐ paused: verify failed';
  const shown = pause ? badge : statusText(status);
  const stage = c.stage === 'finished' ? stages.at(-1)?.tentacle ?? '' : c.stage;
  return box(`🦑 chain ${c.name} › ${stage}`, shown, [
    ['chain', c.id],
    ['stages', stages.map((st, i) => `${st.tentacle} ${stageMark(c, i, status, pause)}`).join(' → '), 2],
    ['time', timeLine(sum.elapsed_s * 1000, sum.cost_usd, sum.tools, fix)],
    ['now', finished || pause ? null : sum.now],
    ['question', sum.question, 3],
    ['paused', pauseText(pause), 2],
    ['result', json(c.result, null)?.note, 2],
    ['branch', write?.branch && !write.outcome ? write.branch : null],
    ['error', c.error, 2],
    ['next', finished || status === 'waiting' ? chainNext(c, status, cur, pause, stages) : null, 3],
  ]);
}

function describeBrief(run, full) {
  const d = describe(run, full);
  return { id: d.id, tentacle: d.tentacle, status: d.status, verdict: d.verdict, error: d.error,
    stopped: d.stopped,
    recent: d.recent_messages.slice(-2).map((m) => m.body.slice(0, 160)), cost_usd: d.metrics.cost_usd };
}
