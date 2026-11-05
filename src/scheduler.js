// Scheduling: at most max_parallel runs at once (the rest wait as 'queued'), the daily budget, and
// recovery of runs whose worker died. Workers and pipeline drivers are detached node processes.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, db, getRun, updateRun, addMessage, nowIso, getSetting, spentToday } from './store.js';
import { alive, killTree } from './platform.js';

// ---- daily budget: no new runs once today's spend reaches it ----

export function dailyBudget() {
  const v = Number(getSetting('daily_budget_usd'));
  return v > 0 ? v : null;
}
export function checkBudget() {
  const budget = dailyBudget();
  if (!budget) return;
  const spent = spentToday();
  if (spent >= budget) {
    throw new Error(`today's spend $${spent.toFixed(2)} has reached the daily budget $${budget}. ` +
      'The developer can raise it with: krakenmcp budget <usd>');
  }
}

// ---- scheduling: at most max_parallel runs at once; the rest wait as 'queued' ----

export const DEFAULT_MAX_PARALLEL = 3;
export function maxParallel() {
  const v = Number(getSetting('max_parallel') ?? process.env.KRAKEN_MAX_PARALLEL ?? DEFAULT_MAX_PARALLEL);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_PARALLEL;
}

// Runs whose worker died (crash, reboot, kill -9) would otherwise show 'running' forever.
export function reapStale() {
  const reaped = [];
  for (const r of db.prepare("SELECT id, session, pid, agent_pid FROM runs WHERE status = 'running'").all()) {
    if (alive(r.pid)) continue;
    killTree(r.agent_pid);
    updateRun(r.id, { status: 'failed', finished_at: nowIso(), error: 'the worker process exited unexpectedly (crash or restart)' });
    addMessage({ session: r.session, run_id: r.id, sender: 'kraken', kind: 'failed', body: 'worker died; marked failed' });
    reaped.push(r.id);
  }
  // Claimed by the scheduler but the worker never started (spawn failed): put back in the queue.
  const stale = new Date(Date.now() - 60_000).toISOString();
  db.prepare("UPDATE runs SET pid = NULL, claimed_at = NULL WHERE status = 'queued' AND pid = -1 AND claimed_at < ?").run(stale);
  // Pipelines whose driver died.
  for (const p of db.prepare("SELECT id, pid FROM pipelines WHERE status IN ('running', 'waiting')").all()) {
    if (p.pid > 0 && !alive(p.pid)) {
      db.prepare("UPDATE pipelines SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run('the pipeline driver exited unexpectedly (crash or restart); its runs are kept', nowIso(), p.id);
    }
  }
  return reaped;
}

// Start queued runs while there is capacity. Claiming happens in one IMMEDIATE transaction, so
// several processes (server, workers) pumping at once cannot overfill the limit.
export function pump() {
  reapStale();
  const claimed = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const active = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running' OR (status = 'queued' AND pid = -1)").get().n;
    const free = maxParallel() - active;
    if (free > 0) {
      const next = db.prepare("SELECT id FROM runs WHERE status = 'queued' AND pid IS NULL ORDER BY created_at LIMIT ?").all(free);
      for (const { id } of next) {
        db.prepare('UPDATE runs SET pid = -1, claimed_at = ? WHERE id = ?').run(nowIso(), id);
        claimed.push(id);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  claimed.forEach(startWorker);
  return claimed;
}

export function queueInfo(runId) {
  const run = getRun(runId);
  if (run?.status !== 'queued' || run.pid === -1) return undefined;
  const ahead = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued' AND pid IS NULL AND created_at < ?").get(run.created_at).n;
  return { waiting_for_slot: true, ahead, max_parallel: maxParallel() };
}

export function startWorker(runId) {
  startNode('worker.js', runId);
}

export function startNode(script, id) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', script), id], {
    detached: true, stdio: 'ignore', env: process.env, windowsHide: true,
  });
  child.unref();
  return child.pid;
}
