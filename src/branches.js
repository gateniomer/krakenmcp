// Git helpers and everything about a write run's kraken/<run_id> branch: worktrees, merge, discard,
// update (merge the developer's branch in), and the diff a review reads.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { db, IN_PROGRESS, getRun, addMessage, latestReview, getSetting } from './store.js';
import { mustRun, resumeRun } from './control.js';

export const gitIn = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const tryGit = (dir, ...args) => { try { return gitIn(dir, ...args); } catch { return null; } };

// ---- discard / merge (write runs with a kraken/<run_id> branch) ----

function branchRun(id) {
  const run = mustRun(id);
  if (run.access !== 'write') throw new Error(`${id} is a ${run.tentacle} (read) run; nothing to merge or discard`);
  if (!run.branch) throw new Error(`${id} edited the repo in place (isolation none); review it with git yourself`);
  if (run.outcome) throw new Error(`${id} was already ${run.outcome}`);
  if (IN_PROGRESS.includes(run.status)) throw new Error(`${id} is still ${run.status}; cancel it first`);
  return run;
}

// The worktree folder was deleted by hand (or by a cleanup tool) but the branch is still there:
// put the worktree back so the run can be resumed, updated or reviewed.
export function ensureWorktree(run) {
  if (!run.branch || existsSync(run.workdir)) return false;
  if (!tryGit(run.cwd, 'rev-parse', '--verify', '--quiet', run.branch)) throw new Error(`branch ${run.branch} no longer exists`);
  tryGit(run.cwd, 'worktree', 'prune');
  gitIn(run.cwd, 'worktree', 'add', run.workdir, run.branch);
  addMessage({ session: run.session, run_id: run.id, sender: 'kraken', kind: 'progress', body: `recreated missing worktree ${run.workdir}` });
  return true;
}

// Files that would conflict if `branch` were merged into `into`, without touching any checkout
// (git merge-tree, git 2.38+). null when git cannot tell.
export function predictConflicts(dir, into, branch) {
  try {
    execFileSync('git', ['-C', dir, 'merge-tree', '--write-tree', '--name-only', '--no-messages', into, branch],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (e) {
    if (e.status !== 1 || !e.stdout) return null;
    return e.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  }
}

// The newest run on a branch (runs that resume a run share its branch and agent session).
const latestOnBranch = (branch) => db.prepare('SELECT * FROM runs WHERE branch = ? ORDER BY created_at DESC LIMIT 1').get(branch);

function removeWorktree(run) {
  if (existsSync(run.workdir)) tryGit(run.cwd, 'worktree', 'remove', '--force', run.workdir);
  tryGit(run.cwd, 'worktree', 'prune');
}

// A run and the runs that resumed it share one branch; they all share its fate.
function setBranchOutcome(branch, outcome, detail) {
  db.prepare('UPDATE runs SET outcome = ?, outcome_detail = ? WHERE branch = ? AND outcome IS NULL').run(outcome, detail, branch);
}

export function discardRun(id) {
  const run = branchRun(id);
  removeWorktree(run);
  tryGit(run.cwd, 'branch', '-D', run.branch);
  setBranchOutcome(run.branch, 'discarded', `deleted ${run.branch} and its worktree`);
  addMessage({ session: run.session, run_id: id, sender: 'kraken', kind: 'discarded', body: `discarded ${run.branch}` });
  return { run_id: id, outcome: 'discarded', branch: run.branch };
}

// ---- approval mode: "ask" (default) or "auto" (krakenmcp mode auto) ----

export const approvalMode = () => (getSetting('approval_mode') === 'auto' ? 'auto' : 'ask');

// Where the branch's verify command came from: the first run on the branch resolved it.
const verifySource = (run) => {
  const first = db.prepare('SELECT config FROM runs WHERE branch = ? ORDER BY created_at LIMIT 1').get(run.branch);
  try { return JSON.parse(first?.config ?? '{}').sources?.verify; } catch { return undefined; }
};

// Why a branch may not merge without asking, in auto mode. Empty: approved, verified, clean.
function autoMergeBlockers(run, { review, conflicts, uncommitted, commits, dirty }) {
  return [
    run.status !== 'done' ? `run status is ${run.status}` : null,
    review?.verdict !== 'approve' ? `the latest review ${review ? `says ${review.verdict ?? review.status}` : 'is missing'}` : null,
    !run.verify_cmd ? 'it has no verify command (auto mode merges only verified work)' : null,
    run.verify_cmd && verifySource(run) === 'call'
      ? 'its verify command was passed in the call, not set by the developer (krakenmcp set execute verify=...)' : null,
    conflicts === null || conflicts.length ? 'merging may conflict' : null,
    uncommitted ? 'the worktree has uncommitted changes' : null,
    !commits ? 'the branch has no commits' : null,
    dirty ? 'the main checkout has uncommitted changes' : null,
  ].filter(Boolean);
}

// Two-step merge: without `confirm` it returns a preview and a confirm token (the branch head).
// The coordinator must show the preview to the developer and only confirm after they say yes.
// In auto mode a branch with no blockers (see above) merges at once instead.
export function mergeRun(id, confirm) {
  const run = branchRun(id);
  const head = tryGit(run.cwd, 'rev-parse', run.branch);
  if (!head) throw new Error(`branch ${run.branch} no longer exists`);
  const base = run.base_sha ?? tryGit(run.cwd, 'merge-base', 'HEAD', run.branch);
  const target = gitIn(run.cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const commits = tryGit(run.cwd, 'log', '--oneline', `${base}..${run.branch}`) ?? '';
  const uncommitted = existsSync(run.workdir) ? tryGit(run.workdir, 'status', '--porcelain') : '';
  const review = latestReview(id);
  const conflicts = predictConflicts(run.cwd, 'HEAD', run.branch);
  const dirty = gitIn(run.cwd, 'status', '--porcelain', '--untracked-files=no');
  const mode = approvalMode();
  const blockers = mode === 'auto' && !confirm ? autoMergeBlockers(run, { review, conflicts, uncommitted, commits, dirty }) : null;
  const auto = blockers?.length === 0;
  if (auto) confirm = head;

  if (!confirm) {
    return {
      approval_mode: mode, auto_merge_blocked_by: blockers ?? undefined,
      run_id: id, preview: true, branch: run.branch, into: target, repo: run.cwd,
      commits: commits ? commits.split('\n') : [],
      diffstat: tryGit(run.cwd, 'diff', '--stat', `${base}...${run.branch}`),
      run_status: run.status,
      verify: run.verify_cmd ? { cmd: run.verify_cmd, exit: run.verify_exit } : null,
      review: review ?? 'none (consider review(run_id) first)',
      warnings: [
        run.status !== 'done' ? `run status is ${run.status}` : null,
        review && review.verdict !== 'approve' ? `latest review verdict: ${review.verdict ?? review.status}` : null,
        uncommitted ? 'the worktree has uncommitted changes that will NOT be merged' : null,
        !commits ? 'the branch has no commits to merge' : null,
        conflicts?.length ? `merging will conflict in: ${conflicts.join(', ')}. Call update(run_id) first; it merges ` +
          `${target} into the branch and lets the agent resolve the conflicts` : null,
      ].filter(Boolean),
      conflicts: conflicts ?? 'unknown (git 2.38+ needed to predict)',
      confirm_token: head,
      next: 'Show this preview to the developer. Only after they approve, call merge again with confirm = confirm_token.',
    };
  }
  if (confirm !== head) throw new Error('confirm token does not match the branch head (it changed); preview again');
  if (!commits) throw new Error('the branch has no commits to merge');
  if (dirty) throw new Error(`the main checkout has uncommitted changes; commit or stash them first:\n${dirty}`);

  try {
    gitIn(run.cwd, 'merge', '--no-ff', '-m', `Merge ${run.branch}: ${run.task.slice(0, 60)}`, run.branch);
  } catch (e) {
    const files = tryGit(run.cwd, 'diff', '--name-only', '--diff-filter=U');
    tryGit(run.cwd, 'merge', '--abort');
    throw new Error(`merge failed and was aborted; the branch is kept.${files ? ` Conflicts:\n${files}` : `\n${e.message}`}` +
      '\nCall update(run_id) to merge the current branch into the run\'s branch and have the agent resolve the conflicts.');
  }
  const mergeCommit = gitIn(run.cwd, 'rev-parse', '--short', 'HEAD');
  removeWorktree(run);
  tryGit(run.cwd, 'branch', '-d', run.branch);
  setBranchOutcome(run.branch, 'merged', `merged into ${target} as ${mergeCommit}`);
  addMessage({ session: run.session, run_id: id, sender: 'kraken', kind: 'merged',
    body: `merged into ${target} (${mergeCommit})${auto ? ' automatically (approval mode auto)' : ''}` });
  return { run_id: id, outcome: 'merged', into: target, merge_commit: mergeCommit, branch_deleted: run.branch,
    auto: auto || undefined, note: auto ? 'auto mode: the review approved and verify passed, so it merged without asking' : undefined };
}

// ---- update: bring a run's branch up to date with the developer's current branch ----

// Merges the main checkout's current branch into kraken/<run_id> inside the run's worktree.
// Clean: done, no agent needed. Conflicts: with resolve (default) the merge is left in progress and
// the run's own agent session is resumed to resolve it; Kraken commits the result, which concludes
// the merge. Without resolve, the merge is aborted and the conflicting files are listed.
export function syncBranch(id, { resolve = true, session } = {}) {
  branchRun(id);
  const run = latestOnBranch(getRun(id).branch);
  if (IN_PROGRESS.includes(run.status)) throw new Error(`${run.id} on ${run.branch} is still ${run.status}`);
  ensureWorktree(run);
  if (tryGit(run.workdir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')) {
    throw new Error(`a merge is already in progress in ${run.workdir}; resume ${run.id} to finish it, or discard the run`);
  }
  const dirty = gitIn(run.workdir, 'status', '--porcelain');
  if (dirty) throw new Error(`the worktree has uncommitted changes (a waiting run?); answer or resume ${run.id} first:\n${dirty}`);
  const into = gitIn(run.cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const sha = gitIn(run.cwd, 'rev-parse', 'HEAD');
  if (tryGit(run.cwd, 'merge-base', '--is-ancestor', sha, run.branch) !== null) {
    return { run_id: id, branch: run.branch, updated: false, note: `${run.branch} already contains ${into}` };
  }
  const say = (body) => addMessage({ session: run.session, run_id: run.id, sender: 'kraken', kind: 'progress', body });
  try {
    gitIn(run.workdir, '-c', 'user.name=Kraken', '-c', 'user.email=kraken@localhost',
      'merge', '--no-ff', '--no-edit', '-m', `Merge ${into} into ${run.branch}`, sha);
    db.prepare('UPDATE runs SET base_sha = ? WHERE branch = ?').run(sha, run.branch);
    say(`merged ${into} (${sha.slice(0, 7)}) into ${run.branch}`);
    return { run_id: id, branch: run.branch, updated: true, merged: into, new_base: sha.slice(0, 7), conflicts: [],
      next: run.verify_cmd ? 'the merge was clean; consider resume(run_id, "run the checks") or review(run_id) before merging' : undefined };
  } catch (e) {
    const conflicts = (tryGit(run.workdir, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
    if (!conflicts.length) { tryGit(run.workdir, 'merge', '--abort'); throw new Error(`could not merge ${into}: ${e.message}`); }
    if (!resolve || !run.native_session) {
      tryGit(run.workdir, 'merge', '--abort');
      return { run_id: id, branch: run.branch, updated: false, conflicts,
        note: resolve ? `${run.id} has no agent session to resolve them; discard and start again from ${into}` : 'merge aborted' };
    }
    say(`merging ${into} into ${run.branch}: conflicts in ${conflicts.join(', ')}; resuming the agent to resolve them`);
    const instruction = [
      `Kraken is merging the developer's branch "${into}" into this branch, and git reported conflicts in:`,
      ...conflicts.map((f) => `- ${f}`),
      'Resolve every conflict: remove all conflict markers and keep the intent of both sides (yours and theirs).',
      'Then run the checks you need. Do not run git commit, git merge, git rebase or git checkout yourself; Kraken',
      'commits your resolution to finish the merge. Summarize how you resolved each file.',
    ].join('\n');
    const r = resumeRun(run.id, instruction, { session, syncBase: sha, merging: true });
    return { ...r, branch: run.branch, updated: 'resolving', merged: into, conflicts };
  }
}

// ---- review input ----

const MAX_DIFF = 80_000;
const capDiff = (d) => (d.length > MAX_DIFF
  ? `${d.slice(0, MAX_DIFF)}\n…[diff truncated at ${MAX_DIFF} chars of ${d.length}; read the files for the rest]` : d);

// Diff for review: a Kraken run's changes (committed on its branch + anything uncommitted in its
// worktree), or the uncommitted changes in `dir`.
export function reviewInput(targetId, dir) {
  if (targetId) {
    const tr = mustRun(targetId);
    if (tr.access !== 'write') throw new Error(`${targetId} is a read run; review a write run (e.g. execute)`);
    if (IN_PROGRESS.includes(tr.status)) throw new Error(`${targetId} is still ${tr.status}`);
    if (tr.outcome === 'discarded') throw new Error(`${targetId} was discarded`);
    if (tr.outcome === 'merged') throw new Error(`${targetId} was already merged; review the main checkout instead`);
    if (!existsSync(tr.workdir) && !(tr.branch && ensureWorktree(tr))) {
      throw new Error(`${targetId}'s worktree is gone; review the main checkout instead`);
    }
    const base = tr.base_sha ?? 'HEAD';
    const diff = gitIn(tr.workdir, 'diff', base);
    const untracked = tryGit(tr.workdir, 'ls-files', '--others', '--exclude-standard');
    if (!diff && !untracked) throw new Error(`${targetId} made no changes`);
    return {
      target: tr, workdir: tr.workdir, cwd: tr.cwd,
      diff: capDiff(diff + (untracked ? `\n\nUntracked new files (read them):\n${untracked}` : '')),
      planId: tr.plan_id,
    };
  }
  const diff = gitIn(dir, 'diff', 'HEAD');
  const untracked = tryGit(dir, 'ls-files', '--others', '--exclude-standard');
  if (!diff && !untracked) throw new Error(`no uncommitted changes to review in ${dir}; pass run_id to review a Kraken run`);
  return { target: null, workdir: dir, cwd: dir, diff: capDiff(diff + (untracked ? `\n\nUntracked new files (read them):\n${untracked}` : '')) };
}
