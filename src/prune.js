// krakenmcp prune: old logs/result files, oversized stored prompts, and abandoned worktrees.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOGS_DIR, PLANS_DIR, WORKTREES_DIR, db } from './store.js';
import { discardRun } from './branches.js';

export function pruneData({ olderThanDays = 30, dryRun = false, worktrees = false } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const report = { older_than_days: olderThanDays, dry_run: dryRun, files_removed: 0, bytes_freed: 0,
    prompts_cleared: 0, worktrees_discarded: [], unmerged_worktrees: [], orphan_worktree_dirs: [] };

  const old = db.prepare(`SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?
                          AND status NOT IN ('queued', 'running', 'waiting')`).all(cutoff);
  for (const { id } of old) {
    for (const f of [join(LOGS_DIR, `${id}.log`), join(LOGS_DIR, `${id}.last.txt`), join(PLANS_DIR, `${id}.md`)]) {
      if (!existsSync(f)) continue;
      report.files_removed++; report.bytes_freed += statSync(f).size;
      if (!dryRun) rmSync(f);
    }
  }
  // Prompts can hold whole diffs; results and metrics are kept for history and stats.
  const big = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE finished_at < ? AND status NOT IN ('queued','running','waiting')
                          AND (prompt IS NOT NULL OR verify_output IS NOT NULL)`).get(cutoff).n;
  report.prompts_cleared = big;
  if (!dryRun && big) {
    db.prepare(`UPDATE runs SET prompt = NULL, verify_output = NULL WHERE finished_at < ?
                AND status NOT IN ('queued','running','waiting')`).run(cutoff);
  }

  // Write runs whose branch was never merged or discarded.
  const open = db.prepare(`SELECT id, branch, workdir, finished_at, status FROM runs
                           WHERE branch IS NOT NULL AND outcome IS NULL AND status NOT IN ('queued','running')`).all();
  const seen = new Set(); // resumed runs share their branch: handle each branch once
  for (const r of open) {
    if (seen.has(r.branch) || !existsSync(r.workdir)) continue;
    seen.add(r.branch);
    const stale = r.finished_at && r.finished_at < cutoff && r.status !== 'waiting';
    if (worktrees && stale) {
      if (!dryRun) discardRun(r.id);
      report.worktrees_discarded.push(r.branch);
    } else report.unmerged_worktrees.push({ run_id: r.id, branch: r.branch, finished_at: r.finished_at, status: r.status });
  }
  // Worktree folders Kraken has no record of (e.g. a deleted database).
  const known = new Set(db.prepare('SELECT id FROM runs').all().map((r) => r.id));
  if (existsSync(WORKTREES_DIR)) {
    for (const d of readdirSync(WORKTREES_DIR)) if (!known.has(d)) report.orphan_worktree_dirs.push(join(WORKTREES_DIR, d));
  }
  if (!dryRun && report.prompts_cleared) db.exec('VACUUM');
  return report;
}
