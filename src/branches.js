// Everything about a write run's kraken/<run_id> branch: merge, discard, update (merge the
// developer's branch in), and the diff a review reads.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { db, IN_PROGRESS, getRun, addMessage, latestReview } from './store.js';
import { resolveTentacle } from './tentacles.js';
import { mustRun, resumeRun } from './control.js';
import { gitIn, tryGit, ensureWorktree } from './git.js';
import { parseJson, fail } from './util.js';

// ---- discard / merge (write runs with a kraken/<run_id> branch) ----

function branchRun(id) {
  const run = mustRun(id);
  if (run.access !== 'write') fail(`${id} is a ${run.tentacle} (read) run; nothing to merge or discard`);
  if (run.outcome) fail(`${id} was already ${run.outcome}`);
  if (IN_PROGRESS.includes(run.status)) fail(`${id} is still ${run.status}; cancel it first`);
  return run;
}

// Files that would conflict if `branch` were merged into `into`, without touching any checkout
// (git merge-tree, git 2.38+). null when git cannot tell.
export function predictConflicts(dir, into, branch) {
  const args = ['-C', dir, 'merge-tree', '--write-tree', '--name-only', '--no-messages', into, branch];
  try {
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (e) {
    if (e.status !== 1 || !e.stdout) return null;
    return e.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  }
}

// The newest run on a branch (runs that resume a run share its branch and agent session).
const latestOnBranch = (branch) =>
  db.prepare('SELECT * FROM runs WHERE branch = ? ORDER BY created_at DESC LIMIT 1').get(branch);

function removeWorktree(run) {
  if (existsSync(run.workdir)) tryGit(run.cwd, 'worktree', 'remove', '--force', run.workdir);
  tryGit(run.cwd, 'worktree', 'prune');
}

// A run and the runs that resumed it share one branch; they all share its fate.
function setBranchOutcome(branch, outcome, detail) {
  db.prepare('UPDATE runs SET outcome = ?, outcome_detail = ? WHERE branch = ? AND outcome IS NULL')
    .run(outcome, detail, branch);
}

const note = (run, kind, body) =>
  addMessage({ session: run.session, run_id: run.id, sender: 'kraken', kind, body });

export function discardRun(id) {
  const run = branchRun(id);
  removeWorktree(run);
  tryGit(run.cwd, 'branch', '-D', run.branch);
  setBranchOutcome(run.branch, 'discarded', `deleted ${run.branch} and its worktree`);
  note(run, 'discarded', `discarded ${run.branch}`);
  return { run_id: id, outcome: 'discarded', branch: run.branch };
}

// ---- merging follows the review tentacle's autonomy: ask (default) or auto ----

// The autonomy of the tentacle behind the branch's latest review; no review means ask.
export function reviewAutonomy(run) {
  const review = latestReview(run.id);
  if (!review) return 'ask';
  try { return resolveTentacle(review.tentacle, run.cwd).autonomy; } catch { return 'ask'; }
}

// Where the branch's verify command came from: the first run on the branch resolved it.
const verifySource = (run) => {
  const first = db.prepare('SELECT config FROM runs WHERE branch = ? ORDER BY created_at LIMIT 1')
    .get(run.branch);
  return parseJson(first?.config, {}).sources?.verify;
};

const CALL_VERIFY = 'its verify command was passed in the call, not set by the developer ' +
  '(verify: in ~/.kraken/tentacles/execute.md)';

// Why a branch may not merge without a preview. Empty: approved, verified, clean.
function autoMergeBlockers(run, { review, conflicts, uncommitted, commits, dirty }) {
  const reviewSays = review ? `says ${review.verdict ?? review.status}` : 'is missing';
  return [
    run.status !== 'done' ? `run status is ${run.status}` : null,
    review?.verdict !== 'approve' ? `the latest review ${reviewSays}` : null,
    !run.verify_cmd ? 'it has no verify command (merging without a preview needs verified work)' : null,
    run.verify_cmd && verifySource(run) === 'call' ? CALL_VERIFY : null,
    conflicts === null || conflicts.length ? 'merging may conflict' : null,
    uncommitted ? 'the worktree has uncommitted changes' : null,
    !commits ? 'the branch has no commits' : null,
    dirty ? 'the main checkout has uncommitted changes' : null,
  ].filter(Boolean);
}

function previewWarnings(run, { review, uncommitted, commits, conflicts, target }) {
  return [
    run.status !== 'done' ? `run status is ${run.status}` : null,
    review && review.verdict !== 'approve' ? `latest review verdict: ${review.verdict ?? review.status}`
      : null,
    uncommitted ? 'the worktree has uncommitted changes that will NOT be merged' : null,
    !commits ? 'the branch has no commits to merge' : null,
    conflicts?.length ? `merging will conflict in: ${conflicts.join(', ')}. Call update(run_id) first; ` +
      `it merges ${target} into the branch and lets the agent resolve the conflicts` : null,
  ].filter(Boolean);
}

// Two-step merge: without `confirm` it returns a preview and a confirm token (the branch head).
// The head must show the preview to the developer and only confirm after they say yes.
// When the review's autonomy is auto, a branch with no blockers (see above) merges at once instead.
// The blockers are always reported, so a head working in auto for a session can check them.
export function mergeRun(id, confirm, { autonomy } = {}) {
  const run = branchRun(id);
  const head = tryGit(run.cwd, 'rev-parse', run.branch) ?? fail(`branch ${run.branch} no longer exists`);
  const base = run.base_sha ?? tryGit(run.cwd, 'merge-base', 'HEAD', run.branch);
  const facts = {
    review: latestReview(id),
    target: gitIn(run.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
    commits: tryGit(run.cwd, 'log', '--oneline', `${base}..${run.branch}`) ?? '',
    uncommitted: existsSync(run.workdir) ? tryGit(run.workdir, 'status', '--porcelain') : '',
    conflicts: predictConflicts(run.cwd, 'HEAD', run.branch),
    dirty: gitIn(run.cwd, 'status', '--porcelain', '--untracked-files=no'),
  };
  const mode = autonomy ?? reviewAutonomy(run);
  const blockers = confirm ? null : autoMergeBlockers(run, facts);
  const auto = mode === 'auto' && blockers?.length === 0;
  if (auto) confirm = head;
  if (!confirm) {
    return {
      review_autonomy: mode, auto_merge_blocked_by: blockers,
      run_id: id, preview: true, branch: run.branch, into: facts.target, repo: run.cwd,
      commits: facts.commits ? facts.commits.split('\n') : [],
      diffstat: tryGit(run.cwd, 'diff', '--stat', `${base}...${run.branch}`),
      run_status: run.status,
      verify: run.verify_cmd ? { cmd: run.verify_cmd, exit: run.verify_exit } : null,
      review: facts.review ?? 'none (consider review(run_id) first)',
      warnings: previewWarnings(run, facts),
      conflicts: facts.conflicts ?? 'unknown (git 2.38+ needed to predict)',
      confirm_token: head,
      next: 'ask: show this preview to the developer; call merge again with confirm = confirm_token ' +
        'only after they approve',
    };
  }
  if (confirm !== head) fail('confirm token does not match the branch head (it changed); preview again');
  if (!facts.commits) fail('the branch has no commits to merge');
  if (facts.dirty) {
    fail(`the main checkout has uncommitted changes; commit or stash them first:\n${facts.dirty}`);
  }
  return landBranch(run, facts.target, auto);
}

function landBranch(run, target, auto) {
  try {
    gitIn(run.cwd, 'merge', '--no-ff', '-m', `Merge ${run.branch}: ${run.task.slice(0, 60)}`, run.branch);
  } catch (e) {
    const files = tryGit(run.cwd, 'diff', '--name-only', '--diff-filter=U');
    tryGit(run.cwd, 'merge', '--abort');
    const detail = files ? ` Conflicts:\n${files}` : `\n${e.message}`;
    fail(`merge failed and was aborted; the branch is kept.${detail}\n` +
      'Call update(run_id): it merges the current branch into the run\'s branch and the agent resolves it.');
  }
  const mergeCommit = gitIn(run.cwd, 'rev-parse', '--short', 'HEAD');
  removeWorktree(run);
  tryGit(run.cwd, 'branch', '-d', run.branch);
  setBranchOutcome(run.branch, 'merged', `merged into ${target} as ${mergeCommit}`);
  const how = auto ? ' automatically (review autonomy auto)' : '';
  note(run, 'merged', `merged into ${target} (${mergeCommit})${how}`);
  return {
    run_id: run.id, outcome: 'merged', into: target, merge_commit: mergeCommit, branch_deleted: run.branch,
    auto: auto || undefined,
    note: auto ? 'review autonomy is auto: the review approved and verify passed, so it merged without asking'
      : undefined,
  };
}

// ---- update: bring a run's branch up to date with the developer's current branch ----

const conflictInstruction = (into, conflicts) => [
  `Kraken is merging the developer's branch "${into}" into this branch, and git reported conflicts in:`,
  ...conflicts.map((f) => `- ${f}`),
  'Resolve every conflict: remove all conflict markers and keep the intent of both sides (yours and theirs).',
  'Then run the checks you need. Do not run git commit, git merge, git rebase or git checkout yourself;',
  'Kraken commits your resolution to finish the merge. Summarize how you resolved each file.',
].join('\n');

// Merges the main checkout's current branch into kraken/<run_id> inside the run's worktree.
// Clean: done, no agent needed. Conflicts: with resolve (default) the merge is left in progress and
// the run's own agent session is resumed to resolve it; Kraken commits the result, which concludes
// the merge. Without resolve, the merge is aborted and the conflicting files are listed.
export function syncBranch(id, { resolve = true, session } = {}) {
  branchRun(id);
  const run = latestOnBranch(getRun(id).branch);
  if (IN_PROGRESS.includes(run.status)) fail(`${run.id} on ${run.branch} is still ${run.status}`);
  ensureWorktree(run);
  if (tryGit(run.workdir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')) {
    fail(`a merge is already in progress in ${run.workdir}; resume ${run.id} to finish it, or discard it`);
  }
  const dirty = gitIn(run.workdir, 'status', '--porcelain');
  if (dirty) {
    fail(`the worktree has uncommitted changes (a waiting run?); answer or resume ${run.id} first:\n` +
      dirty);
  }
  const into = gitIn(run.cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const sha = gitIn(run.cwd, 'rev-parse', 'HEAD');
  const reply = { run_id: id, branch: run.branch };
  if (tryGit(run.cwd, 'merge-base', '--is-ancestor', sha, run.branch) !== null) {
    return { ...reply, updated: false, note: `${run.branch} already contains ${into}` };
  }
  try {
    gitIn(run.workdir, '-c', 'user.name=Kraken', '-c', 'user.email=kraken@localhost',
      'merge', '--no-ff', '--no-edit', '-m', `Merge ${into} into ${run.branch}`, sha);
  } catch (e) {
    return resolveConflicts(run, { reply, into, sha, error: e, resolve, session });
  }
  db.prepare('UPDATE runs SET base_sha = ? WHERE branch = ?').run(sha, run.branch);
  note(run, 'progress', `merged ${into} (${sha.slice(0, 7)}) into ${run.branch}`);
  const next = run.verify_cmd
    ? 'the merge was clean; consider resume(run_id, "run the checks") or review(run_id) before merging'
    : undefined;
  return { ...reply, updated: true, merged: into, new_base: sha.slice(0, 7), conflicts: [], next };
}

function resolveConflicts(run, { reply, into, sha, error, resolve, session }) {
  const unmerged = tryGit(run.workdir, 'diff', '--name-only', '--diff-filter=U') ?? '';
  const conflicts = unmerged.split('\n').filter(Boolean);
  if (!conflicts.length) {
    tryGit(run.workdir, 'merge', '--abort');
    fail(`could not merge ${into}: ${error.message}`);
  }
  if (!resolve || !run.native_session) {
    tryGit(run.workdir, 'merge', '--abort');
    const why = !resolve ? 'merge aborted'
      : `${run.id} has no agent session to resolve them; discard and start again from ${into}`;
    return { ...reply, updated: false, conflicts, note: why };
  }
  note(run, 'progress', `merging ${into} into ${run.branch}: conflicts in ${conflicts.join(', ')}; ` +
    'resuming the agent to resolve them');
  const instruction = conflictInstruction(into, conflicts);
  const r = resumeRun(run.id, instruction, { session, syncBase: sha, merging: true });
  return { ...r, branch: run.branch, updated: 'resolving', merged: into, conflicts };
}

// ---- review input ----

const MAX_DIFF = 80_000;
const TRUNCATED = (n) => `\n…[diff truncated at ${MAX_DIFF} chars of ${n}; read the files for the rest]`;
const capDiff = (d) => (d.length <= MAX_DIFF ? d : d.slice(0, MAX_DIFF) + TRUNCATED(d.length));
const withUntracked = (diff, untracked) =>
  capDiff(diff + (untracked ? `\n\nUntracked new files (read them):\n${untracked}` : ''));

// Diff for review: a Kraken run's changes (committed on its branch + anything uncommitted in its
// worktree), or the uncommitted changes in `dir`.
export function reviewInput(targetId, dir) {
  if (!targetId) {
    const diff = gitIn(dir, 'diff', 'HEAD');
    const untracked = tryGit(dir, 'ls-files', '--others', '--exclude-standard');
    if (!diff && !untracked) fail(`no uncommitted changes in ${dir}; pass run_id to review a Kraken run`);
    return { target: null, workdir: dir, cwd: dir, diff: withUntracked(diff, untracked) };
  }
  const tr = mustRun(targetId);
  if (tr.access !== 'write') fail(`${targetId} is a read run; review a write run (e.g. execute)`);
  if (IN_PROGRESS.includes(tr.status)) fail(`${targetId} is still ${tr.status}`);
  if (tr.outcome === 'discarded') fail(`${targetId} was discarded`);
  if (tr.outcome === 'merged') fail(`${targetId} was already merged; review the main checkout instead`);
  if (!existsSync(tr.workdir) && !(tr.branch && ensureWorktree(tr))) {
    fail(`${targetId}'s worktree is gone; review the main checkout instead`);
  }
  const diff = gitIn(tr.workdir, 'diff', tr.base_sha ?? 'HEAD');
  const untracked = tryGit(tr.workdir, 'ls-files', '--others', '--exclude-standard');
  if (!diff && !untracked) fail(`${targetId} made no changes`);
  const reviewDiff = withUntracked(diff, untracked);
  return { target: tr, workdir: tr.workdir, cwd: tr.cwd, diff: reviewDiff, planId: tr.plan_id };
}
