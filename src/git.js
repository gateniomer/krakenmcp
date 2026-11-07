// Git helpers: running git in a directory, and the worktree of a run's kraken/<run_id> branch.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { addMessage } from './store.js';
import { fail } from './util.js';

export const gitIn = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const tryGit = (dir, ...args) => { try { return gitIn(dir, ...args); } catch { return null; } };

export const isGitRepo = (dir) => tryGit(dir, 'rev-parse', '--is-inside-work-tree') === 'true';

// The repository root of `cwd`, or `cwd` itself outside a repository.
export const repoRoot = (cwd) => tryGit(resolve(cwd), 'rev-parse', '--show-toplevel') ?? resolve(cwd);

// The worktree folder was deleted by hand (or by a cleanup tool) but the branch is still there:
// put the worktree back so the run can be resumed, updated or reviewed.
export function ensureWorktree(run) {
  if (!run.branch || existsSync(run.workdir)) return false;
  const branchExists = tryGit(run.cwd, 'rev-parse', '--verify', '--quiet', run.branch);
  if (!branchExists) fail(`branch ${run.branch} no longer exists`);
  tryGit(run.cwd, 'worktree', 'prune');
  gitIn(run.cwd, 'worktree', 'add', run.workdir, run.branch);
  addMessage({ session: run.session, run_id: run.id, sender: 'kraken', kind: 'progress',
    body: `recreated missing worktree ${run.workdir}` });
  return true;
}
