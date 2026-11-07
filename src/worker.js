// Background worker: runs one agent CLI for one run, then records the result.
// Started detached by the MCP server so long runs never block a tool call
// and survive the server restarting.
//
// Once a second it checks the database: cancel() sets cancel_requested, and the live cost/tokens are saved
// and checked against the run's
// max_cost_usd / max_tokens. Stopping kills the agent's whole process tree.
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
const limits = config.limits ?? {}; // { max_cost_usd, max_tokens } resolved when the run was created
const lastMessageFile = join(LOGS_DIR, `${runId}.last.txt`);
// The prompt was rendered when the run was created (see tentacles.js); access (read | write) maps to
// the agent's read-only or write mode, so the prompt cannot widen permissions.
// Set when the run was created by resume/answer.
const resumeSession = run.native_session ?? null;
const args = agent.build(run.access,
  { prompt: run.prompt, model: run.model, effort: run.effort, lastMessageFile, resumeSession });
// Agents that can enforce a spend cap themselves get it too (Kraken's own check is per second).
if (limits.max_cost_usd && agent.budgetArgs) args.unshift(...agent.budgetArgs(limits.max_cost_usd));
const log = createWriteStream(join(LOGS_DIR, `${runId}.log`));

// detached: the agent gets its own process group, so cancel/timeout stop it and everything
// it started. KRAKEN_PARENT_RUN tells a Kraken server started by this agent that it is nested.
const child = spawn(agent.path, args, { cwd: run.workdir, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, KRAKEN_PARENT_RUN: runId }, detached: true });
child.on('error', (e) => failEarly(`could not start ${run.agent}: ${e.message}`));
updateRun(runId, { status: 'running', pid: process.pid, agent_pid: child.pid ?? null, started_at: nowIso() });
const effortTag = run.effort ? `#${run.effort}` : '';
say('progress', `${resumeSession ? 'resumed' : 'started'} ${run.tentacle}: ` +
  `${run.agent} ${run.model ?? '(default)'}${effortTag}`);

let stdout = '', buf = '';
child.stdout.on('data', (d) => {
  const s = d.toString(); stdout += s; log.write(s); buf += s;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const p = agent.onLine(line);
    if (p) say('progress', p, run.agent);
  }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; log.write(d); });

let stopReason = null, stopDetail = null; // 'timeout' | 'cancelled' | 'over_budget'
function stop(reason, note) {
  if (stopReason) return;
  stopReason = reason; stopDetail = note;
  say('progress', note);
  killTree(child.pid, 'SIGTERM');
  setTimeout(() => killTree(child.pid, 'SIGKILL'), 10_000).unref();
}
const killer = setTimeout(() => stop('timeout', `timeout after ${run.timeout_min} min, stopping agent`),
  (run.timeout_min ?? 30) * 60 * 1000);

const usedTokens = (t) => (t ? (t.input || 0) + (t.output || 0) + (t.reasoning || 0) : 0);
let lastParsedLength = -1;
function watch() {
  const now = getRun(runId);
  if (now?.cancel_requested) return stop('cancelled', 'cancelled, stopping agent');
  if (stdout.length === lastParsedLength) return;
  lastParsedLength = stdout.length;
  let p;
  try { p = agent.parse(stdout, lastMessageFile, { resumeSession }); } catch { return; }
  // Live metrics, so status shows them while the run goes.
  updateRun(runId, { tokens: p.tokens ? JSON.stringify(p.tokens) : null, cost_usd: p.cost ?? null });
  if (limits.max_cost_usd && p.cost > limits.max_cost_usd) {
    const why = `cost $${p.cost.toFixed(4)} passed max_cost_usd $${limits.max_cost_usd}`;
    return stop('over_budget', `${why}, stopping agent`);
  }
  if (limits.max_tokens && usedTokens(p.tokens) > limits.max_tokens) {
    const why = `${usedTokens(p.tokens)} tokens passed max_tokens ${limits.max_tokens}`;
    return stop('over_budget', `${why}, stopping agent`);
  }
}
const watcher = setInterval(watch, 1000);

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

function diffStat() {
  try {
    git('add', '-A', '--', '.', ...exclude);
    return sumNumstat(git('diff', '--cached', '--numstat'));
  } catch { return null; }
}

function conflictMarkers() {
  try { return git('grep', '--cached', '-l', '-E', '^(<<<<<<<|>>>>>>>)( |$)').split('\n').filter(Boolean); }
  catch { return []; } // git grep exits 1 when nothing matches
}
function hasMergeHead() {
  try { git('rev-parse', '--verify', '--quiet', 'MERGE_HEAD'); return true; } catch { return false; }
}

function runVerify() {
  if (!run.verify_cmd) return null;
  say('progress', `verify: ${run.verify_cmd}`);
  const r = runShell(run.verify_cmd, { cwd: run.workdir, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-2000);
  return { exit: r.status ?? (r.error ? -1 : null), output };
}

// Check and commit a write run's work: Kraken runs verify itself instead of trusting the agent's
// summary, and commits so the kraken/<run_id> branch holds the work (even when verify failed, so it
// can be reviewed). During an update() conflict resolution the commit concludes the merge, and
// leftover conflict markers are never committed.
function commitWork() {
  const verify = runVerify();
  const diff = diffStat();
  const markers = config.sync_base && run.branch ? conflictMarkers() : [];
  const markerError = markers.length
    ? `conflict markers are still in: ${markers.join(', ')}; the merge is not finished` : null;
  if (run.branch && diff && !markerError) {
    const refs = [`run ${runId}`, run.plan_id && `plan ${run.plan_id}`,
      run.resumed_from && `resumes ${run.resumed_from}`].filter(Boolean).join(', ');
    try {
      git('-c', 'user.name=Kraken', '-c', 'user.email=kraken@localhost', 'commit', '-q',
        '-m', `kraken(${run.tentacle}/${run.agent}): ${run.task.slice(0, 64)}`, '-m', refs);
    } catch { /* nothing to commit */ }
    if (config.sync_base && !hasMergeHead()) {
      db.prepare('UPDATE runs SET base_sha = ? WHERE branch = ?').run(config.sync_base, run.branch);
    }
  }
  return { verify, diff, markerError };
}

function finalStatus({ ok, question, verify, markerError }) {
  if (stopReason) return stopReason;
  if (!ok || markerError) return 'failed';
  if (question) return 'waiting';
  return verify && verify.exit !== 0 ? 'verify_failed' : 'done';
}

function errorText(ok, code, p, markerError) {
  if (markerError) return markerError;
  if (ok || stopReason) return null;
  const detail = [p.error, stderr.trim().slice(-2000)].filter(Boolean).join('\n');
  return `exit ${code}: ${detail || '(no output on stderr; see the log)'}`;
}

const json = (v) => (v ? JSON.stringify(v) : null);
const QUESTION = /^\s*KRAKEN_QUESTION:\s*(.+)$/m;
const VERDICT = /VERDICT:\s*\**\s*(approve|changes_requested)/i;

function finish(code, duration_ms) {
  const p = agent.parse(stdout, lastMessageFile, { resumeSession });
  if (!stopReason && p.overBudget) {
    stopReason = 'over_budget';
    stopDetail = `${run.agent} stopped at its --max-budget-usd cap`;
  }
  const ok = !!(code === 0 && p.text && !stopReason);
  const question = ok ? p.text.match(QUESTION)?.[1]?.trim() ?? null : null;
  const isReview = run.tentacle === 'review' || config.needs_diff;
  const verdict = ok && isReview ? p.text.match(VERDICT)?.[1]?.toLowerCase() ?? null : null;
  if (ok && run.access === 'read') writeFileSync(join(PLANS_DIR, `${runId}.md`), `${p.text}\n`);
  // A run that stopped to ask a question keeps its uncommitted work for the resumed run.
  const work = ok && run.access === 'write' && !question ? commitWork() : {};
  const { verify = null, diff = null, markerError = null } = work;
  const status = finalStatus({ ok, question, verify, markerError });
  updateRun(runId, {
    status, result: p.text || null, question, verdict,
    native_session: p.nativeSession ?? run.native_session,
    tokens: json(p.tokens), cost_usd: p.cost, steps: p.steps,
    tool_calls: json(p.toolCalls), diff_stat: json(diff),
    verify_exit: verify?.exit ?? null, verify_output: verify?.output ?? null,
    exit_code: code, duration_ms,
    stop_reason: stopReason === 'over_budget' ? stopDetail : null,
    error: errorText(ok, code, p, markerError),
    finished_at: nowIso(),
  });
  if (question) say('question', question, run.agent);
  const notes = [verify && `verify exit ${verify.exit}`, verdict && `verdict ${verdict}`].filter(Boolean);
  say(status, [`${status} in ${(duration_ms / 1000).toFixed(1)}s`, ...notes].join(', '), run.agent);
}

const startedMs = Date.now();
child.on('close', (code) => {
  clearTimeout(killer);
  clearInterval(watcher);
  log.end();
  finish(code, Date.now() - startedMs);
  pump(); // start the next queued run, if any
  process.exit(0);
});
