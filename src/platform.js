// Process helpers (macOS and Linux): finding executables, stopping a process tree, running shell
// commands, and walking the process ancestry.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

// Find an executable on PATH.
export function which(bin, path = process.env.PATH ?? '') {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const file = join(dir, bin);
    try { accessSync(file, constants.X_OK); return file; } catch { /* keep looking */ }
  }
  return null;
}

// Stop a process and everything it started: its process group (the child was spawned detached,
// so its pid is the group id).
export function killTree(pid, signal = 'SIGTERM') {
  if (!(pid > 0)) return false; // never signal 0 / -1 (process groups of the caller)
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

export function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A shell command line (verify), run with /bin/sh -c.
export const runShell = (cmd, opts) => spawnSync(cmd, { shell: true, ...opts });

// Parent pid chain of `pid`, nearest first.
export function ancestors(pid = process.pid, max = 32) {
  const parentOf = (p) => {
    try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
    catch { return 0; }
  };
  const chain = [];
  for (let p = pid; chain.length < max;) {
    const parent = parentOf(p);
    if (!(parent > 1) || chain.includes(parent)) break;
    chain.push(parent); p = parent;
  }
  return chain;
}
