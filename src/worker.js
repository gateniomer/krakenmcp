// Background worker: runs the agent CLI for one run, then records the result.
// Started detached by the MCP server so long runs never block a tool call
// and survive the server restarting.
//
// A run is one or more segments (one agent process each). A plain run is one segment. A staged run
// (config.stages: the plan has 2+ "Stage" headings) runs one fresh agent session per stage and
// commits after each, so context stays small and a stop loses nothing. A resumed run first continues
// its old session (finishing the stage it stopped in), then runs the stages that are left.
//
// Once a second it checks the database: cancel() sets cancel_requested, and the live cost/tokens are
// saved and checked against the run's max_cost_usd / max_tokens. Stopping kills the agent's whole
// process tree. A write run that stops (timeout, cancel, budget, agent failure) still commits its work
// as a WIP commit, so the branch can be reviewed, resumed or merged.
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgent } from './agents.js';
import { db, getRun, updateRun, addMessage, nowIso, PLANS_DIR, LOGS_DIR } from './store.js';
import { pump } from './scheduler.js';
import { killTree, runShell } from './platform.js';
import { gitIn } from './git.js';
import { parseJson } from './util.js';

const runId = process.argv[2];
const run = getRun(runId);
if (!run) { console.error(`no run ${runId}`); process.exit(1); }
if (run.status === 'cancelled') { pump(); process.exit(0); } // cancelled while queued: free the slot

const say = (kind, body, sender = 'kraken') =>
  addMessage({ session: run.session, run_id: runId, sender, kind, body });

// Anything that fails before the agent runs ends the run as failed (never leaves it queued/running).
function failEarly(message) {
  updateRun(runId, { status: 'failed', pid: process.pid, error: message, finished_at: nowIso() });
  say('failed', message);
  pump();
  process.exit(1);
}
let agent;
try { agent = resolveAgent(run.agent); } catch (e) { failEarly(e.message); }
const config = parseJson(run.config, {});
const settings = config.settings ?? {};
const limits = config.limits ?? {}; // { max_cost_usd, max_tokens } resolved when the run was created
const lastMessageFile = join(LOGS_DIR, `${runId}.last.txt`);
// The prompt was rendered when the run was created (see tentacles.js); access (read | write) maps to
// the agent's read-only or write mode, so the prompt cannot widen permissions.
// Set when the run was created by resume/answer.
const resumeSession = run.native_session ?? null;
const shellTimeoutMs = (settings.verify_timeout_min ?? config.verify_timeout_min ?? 10) * 60 * 1000;
const log = createWriteStream(join(LOGS_DIR, `${runId}.log`));

// ---- segments ----

const staged = config.stages ?? null; // { titles, next }: next = the first stage not finished
const total = staged?.titles.length ?? 0;
const stageBase = config.stage_base_prompt ?? run.prompt;
const stageNote = (k, n, title) => `\n\n--- STAGED RUN ---\nThis plan has ${n} stages. Do ONLY ` +
  `stage ${k + 1} of ${n}: "${title}". Stages before it are already done and committed on this branch: ` +
  'do not redo them, and do not start the next stage. Run the checks this stage lists before you ' +
  'finish. Your final message: what you changed in this stage, check results, anything left undone.';

function planSegments() {
  const segs = [];
  if (resumeSession) {
    const stage = staged && staged.next < total ? staged.next : null;
    segs.push({ prompt: run.prompt, resume: resumeSession, stage });
  }
  if (staged) {
    const from = resumeSession ? Math.min(staged.next + 1, total) : staged.next;
    for (let k = from; k < total; k++) {
      segs.push({ prompt: stageBase + stageNote(k, total, staged.titles[k]), resume: null, stage: k });
    }
  }
  if (!segs.length) segs.push({ prompt: run.prompt, resume: null, stage: null });
  return segs;
}

let child = null, stdout = '', stderr = '', current = null;
let stopReason = null, stopDetail = null; // 'timeout' | 'cancelled' | 'over_budget'
function stop(reason, note) {
  if (stopReason) return;
  stopReason = reason; stopDetail = note;
  say('progress', note);
  if (child) {
    const pid = child.pid;
    killTree(pid, 'SIGTERM');
    setTimeout(() => killTree(pid, 'SIGKILL'), 10_000).unref();
  }
}
const killer = setTimeout(() => stop('timeout', `timeout after ${run.timeout_min} min, stopping agent`),
  (run.timeout_min ?? 30) * 60 * 1000);

// ---- metrics, summed over segments ----

const sum = { tokens: null, cost: null, steps: null, toolCalls: null };
const addNum = (a, b) => (b == null ? a : (a ?? 0) + b);
function addTokens(a, b) {
  if (!b) return a;
  const o = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) o[k] = (o[k] || 0) + (v || 0);
  return o;
}
function addCalls(a, b) {
  if (!b) return a;
  if (!a) return b;
  const by = { ...(a.by_tool ?? {}) };
  for (const [k, v] of Object.entries(b.by_tool ?? {})) by[k] = (by[k] || 0) + v;
  return { total: (a.total || 0) + (b.total || 0), failed: (a.failed || 0) + (b.failed || 0), by_tool: by };
}
const withLive = (p) => ({ tokens: addTokens(sum.tokens, p?.tokens), cost: addNum(sum.cost, p?.cost),
  steps: addNum(sum.steps, p?.steps), toolCalls: addCalls(sum.toolCalls, p?.toolCalls) });

const usedTokens = (t) => (t ? (t.input || 0) + (t.output || 0) + (t.reasoning || 0) : 0);
let lastParsedLength = -1;
function watch() {
  const now = getRun(runId);
  if (now?.cancel_requested) return stop('cancelled', 'cancelled, stopping agent');
  if (!current || stdout.length === lastParsedLength) return;
  lastParsedLength = stdout.length;
  let p;
  try { p = agent.parse(stdout, lastMessageFile, { resumeSession: current.resume }); } catch { return; }
  const t = withLive(p);
  // Live metrics, so status shows them while the run goes.
  updateRun(runId, { tokens: t.tokens ? JSON.stringify(t.tokens) : null, cost_usd: t.cost ?? null });
  if (limits.max_cost_usd && t.cost > limits.max_cost_usd) {
    const why = `cost $${t.cost.toFixed(4)} passed max_cost_usd $${limits.max_cost_usd}`;
    return stop('over_budget', `${why}, stopping agent`);
  }
  if (limits.max_tokens && usedTokens(t.tokens) > limits.max_tokens) {
    const why = `${usedTokens(t.tokens)} tokens passed max_tokens ${limits.max_tokens}`;
    return stop('over_budget', `${why}, stopping agent`);
  }
}
const watcher = setInterval(watch, 1000);

// One agent process; resolves with its exit code.
function runSegment(seg) {
  current = seg; stdout = ''; lastParsedLength = -1;
  const args = agent.build(run.access,
    { prompt: seg.prompt, model: run.model, effort: run.effort, lastMessageFile, resumeSession: seg.resume });
  // Agents that can enforce a spend cap themselves get it too (Kraken's own check is per second).
  if (limits.max_cost_usd && agent.budgetArgs) args.unshift(...agent.budgetArgs(limits.max_cost_usd));
  return new Promise((resolveExit) => {
    // detached: the agent gets its own process group, so cancel/timeout stop it and everything
    // it started. KRAKEN_PARENT_RUN tells a Kraken server started by this agent that it is nested.
    child = spawn(agent.path, args, { cwd: run.workdir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KRAKEN_PARENT_RUN: runId }, detached: true });
    child.on('error', (e) => failEarly(`could not start ${run.agent}: ${e.message}`));
    updateRun(runId, { agent_pid: child.pid ?? null });
    let buf = '';
    child.stdout.on('data', (d) => {
      const s = d.toString(); stdout += s; log.write(s); buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const p = agent.onLine(line);
        if (p) say('progress', p, run.agent);
      }
    });
    child.stderr.on('data', (d) => { stderr += d; log.write(d); });
    child.on('close', (code) => { child = null; resolveExit(code); });
  });
}

// ---- git ----

const git = (...a) => gitIn(run.workdir, ...a);
// Files the agent keeps for itself (e.g. aider's caches) never go into the commit.
const exclude = (agent.ignore ?? []).map((g) => `:(exclude,glob)${g}`);

// Sum `git diff --numstat` output: "<ins>\t<del>\t<path>" ("-" for binary files).
function sumNumstat(out) {
  const lines = out.split('\n').filter(Boolean);
  let insertions = 0, deletions = 0;
  for (const l of lines) {
    const [i, d] = l.split('\t');
    insertions += Number(i) || 0; deletions += Number(d) || 0;
  }
  return { files: lines.length, insertions, deletions };
}
// This run's change: from the commit it started on to what is staged now (all its segments).
let startHead = null, mergeDiff = null;
function diffStat() {
  try {
    git('add', '-A', '--', '.', ...exclude);
    return sumNumstat(git('diff', '--cached', '--numstat', startHead ?? 'HEAD'));
  } catch { return null; }
}
const hasStaged = () => { try { git('diff', '--cached', '--quiet'); return false; } catch { return true; } };

function conflictMarkers() {
  try { return git('grep', '--cached', '-l', '-E', '^(<<<<<<<|>>>>>>>)( |$)').split('\n').filter(Boolean); }
  catch { return []; } // git grep exits 1 when nothing matches
}
function hasMergeHead() {
  try { git('rev-parse', '--verify', '--quiet', 'MERGE_HEAD'); return true; } catch { return false; }
}

function shell(label, cmd) {
  say('progress', `${label}: ${cmd}`);
  const r = runShell(cmd, { cwd: run.workdir, encoding: 'utf8', timeout: shellTimeoutMs });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const output = `${timedOut ? `[${label} timed out after ${shellTimeoutMs / 60000} min]\n` : ''}` +
    `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-2000);
  return { exit: r.status ?? (r.error ? -1 : null), output };
}

const refs = () => [`run ${runId}`, run.plan_id && `plan ${run.plan_id}`,
  config.plan_file && `plan ${config.plan_file}`,
  run.resumed_from && `resumes ${run.resumed_from}`].filter(Boolean).join(', ');
function commit(subject) {
  if (!run.branch || !hasStaged()) return;
  try {
    git('-c', 'user.name=Kraken', '-c', 'user.email=kraken@localhost', 'commit', '-q',
      '-m', subject, '-m', refs());
  } catch { /* nothing to commit */ }
}
const subject = (tag) => `kraken(${tag}/${run.agent}): ${run.task.slice(0, 64)}`;

// Check and commit a write run's work: Kraken runs verify itself instead of trusting the agent's
// summary, and commits so the kraken/<run_id> branch holds the work (even when verify failed, so it
// can be reviewed). During an update() conflict resolution the commit concludes the merge, and
// leftover conflict markers are never committed.
function commitWork(cmd, tag) {
  const verify = cmd ? shell(tag === run.tentacle ? 'verify' : `${tag} verify`, cmd) : null;
  // A conflict merge counts only the agent's own change (staged vs HEAD before the merge commit).
  if (config.sync_base) mergeDiff = diffStat();
  else diffStat(); // stages everything
  const markers = config.sync_base && run.branch ? conflictMarkers() : [];
  const markerError = markers.length
    ? `conflict markers are still in: ${markers.join(', ')}; the merge is not finished` : null;
  if (!markerError) {
    commit(subject(tag));
    if (config.sync_base && run.branch && !hasMergeHead()) {
      db.prepare('UPDATE runs SET base_sha = ? WHERE branch = ?').run(config.sync_base, run.branch);
    }
  }
  return { verify, markerError };
}

// A stopped or failed write run keeps its work as a WIP commit (never during a conflict merge).
function commitWip(why) {
  if (run.access !== 'write' || !run.branch || config.sync_base || hasMergeHead()) return;
  diffStat();
  if (!hasStaged()) return;
  commit(subject(`wip ${why}`));
  say('progress', `work so far committed as WIP (${why})`);
}

// ---- finish ----

function finalStatus({ ok, question, verify, markerError }) {
  if (stopReason) return stopReason;
  if (!ok || markerError) return 'failed';
  if (question) return 'waiting';
  return verify && verify.exit !== 0 ? 'verify_failed' : 'done';
}

function errorText(ok, code, p, markerError) {
  if (markerError) return markerError;
  if (ok || stopReason) return null;
  const detail = [p?.error, stderr.trim().slice(-2000)].filter(Boolean).join('\n');
  return `exit ${code}: ${detail || '(no output on stderr; see the log)'}`;
}

const json = (v) => (v ? JSON.stringify(v) : null);
const QUESTION = /^\s*KRAKEN_QUESTION:\s*(.+)$/m;
const VERDICT = /VERDICT:\s*\**\s*(approve|changes_requested)/i;

function saveStages(next) {
  if (!staged) return;
  config.stages = { ...staged, next };
  config.stage_base_prompt = stageBase;
  updateRun(runId, { config: JSON.stringify(config) });
}

async function main() {
  const startedMs = Date.now();
  updateRun(runId, { status: 'running', pid: process.pid, started_at: nowIso() });
  const effortTag = run.effort ? `#${run.effort}` : '';
  say('progress', `${resumeSession ? 'resumed' : 'started'} ${run.tentacle}: ` +
    `${run.agent} ${run.model ?? '(default)'}${effortTag}`);

  // Setup runs once, in a new worktree, before the agent (e.g. install dependencies).
  if (run.access === 'write' && !run.resumed_from && settings.setup) {
    const r = shell('setup', settings.setup);
    if (r.exit !== 0) {
      updateRun(runId, { status: 'failed', error: `setup failed (exit ${r.exit}):\n${r.output}`,
        finished_at: nowIso(), duration_ms: Date.now() - startedMs });
      say('failed', `setup failed (exit ${r.exit})`);
      return;
    }
  }

  if (run.access === 'write' && run.branch) {
    try { startHead = git('rev-parse', 'HEAD'); } catch { /* no commit yet */ }
  }
  saveStages(staged?.next ?? 0); // keeps the stage prompt for a later resume
  const segs = planSegments();
  const texts = [];
  let code = 0, p = null, ok = true, question = null, verify = null, markerError = null, nativeSession = null;
  let next = staged?.next ?? 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    // A cancel or budget stop can land while a stage check runs (the watcher cannot fire then).
    watch();
    if (stopReason) { ok = false; break; }
    if (seg.stage != null) say('progress', `stage ${seg.stage + 1}/${total}: ${staged.titles[seg.stage]}`);
    code = await runSegment(seg);
    p = agent.parse(stdout, lastMessageFile, { resumeSession: seg.resume });
    Object.assign(sum, withLive(p));
    current = null;
    nativeSession = p.nativeSession ?? nativeSession;
    if (!stopReason && p.overBudget) {
      stopReason = 'over_budget';
      stopDetail = `${run.agent} stopped at its --max-budget-usd cap`;
    }
    const head = seg.stage != null ? `## Stage ${seg.stage + 1}/${total}: ${staged.titles[seg.stage]}\n` : '';
    if (p.text) texts.push(head + p.text);
    ok = !!(code === 0 && p.text && !stopReason);
    if (!ok) break;
    question = p.text.match(QUESTION)?.[1]?.trim() ?? null;
    // A run that stopped to ask a question keeps its uncommitted work for the resumed run.
    if (question) break;
    if (run.access !== 'write') continue;
    if (seg.stage != null && !last) {
      ({ verify, markerError } = commitWork(settings.stage_verify, `stage ${seg.stage + 1}`));
      if (markerError || (verify && verify.exit !== 0)) {
        const why = `stage ${seg.stage + 1} check failed: ${settings.stage_verify}`;
        if (verify) verify.output = `${why}\n${verify.output}`;
        break;
      }
      next = seg.stage + 1;
      saveStages(next);
      const check = verify ? `, check exit ${verify.exit}` : '';
      say('progress', `stage ${seg.stage + 1}/${total} committed${check}`);
      verify = null;
      continue;
    }
    // The last segment: the full verify, once.
    ({ verify, markerError } = commitWork(run.verify_cmd, run.tentacle));
    if (seg.stage != null) { next = seg.stage + 1; saveStages(next); }
  }
  if (!ok && run.access === 'write') commitWip(stopReason ?? 'failed');

  const text = texts.join('\n\n') || null;
  const isReview = run.tentacle === 'review' || config.needs_diff;
  const verdict = ok && isReview ? text.match(VERDICT)?.[1]?.toLowerCase() ?? null : null;
  if (ok && run.access === 'read') writeFileSync(join(PLANS_DIR, `${runId}.md`), `${text}\n`);
  // A waiting run leaves its changes as they are (unstaged) for the resumed run.
  const diff = run.access !== 'write' || !run.branch || question ? null
    : config.sync_base ? mergeDiff : diffStat();
  const status = finalStatus({ ok, question, verify, markerError });
  const duration_ms = Date.now() - startedMs;
  updateRun(runId, {
    status, result: text, question, verdict,
    native_session: nativeSession ?? run.native_session,
    tokens: json(sum.tokens), cost_usd: sum.cost, steps: sum.steps,
    tool_calls: json(sum.toolCalls), diff_stat: json(diff),
    verify_exit: verify?.exit ?? null, verify_output: verify?.output ?? null,
    exit_code: code, duration_ms,
    stop_reason: stopReason === 'over_budget' ? stopDetail : null,
    error: errorText(ok, code, p, markerError),
    finished_at: nowIso(),
  });
  if (question) say('question', question, run.agent);
  const notes = [staged && `stages ${next}/${total}`, verify && `verify exit ${verify.exit}`,
    verdict && `verdict ${verdict}`].filter(Boolean);
  say(status, [`${status} in ${(duration_ms / 1000).toFixed(1)}s`, ...notes].join(', '), run.agent);
}

main().catch((e) => {
  updateRun(runId, { status: 'failed', error: `worker error: ${e.stack ?? e}`, finished_at: nowIso() });
  say('failed', `worker error: ${e.message}`);
}).finally(() => {
  clearTimeout(killer);
  clearInterval(watcher);
  log.end();
  pump(); // start the next queued run, if any
  process.exit(0);
});
