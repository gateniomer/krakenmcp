// Everything that differs between POSIX (macOS, Linux) and Windows, in one place:
// finding executables, starting them safely, stopping a process tree, running shell commands,
// and walking the process ancestry.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

// Executable extensions to try on Windows, native binaries first: a .cmd shim cannot take a
// multi-line argument (cmd.exe ends the command at the first newline), and prompts are multi-line.
export function windowsExts(pathext = process.env.PATHEXT) {
  const list = (pathext || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return [...new Set(['.exe', ...list.filter((e) => e !== '.exe')])];
}

// Find an executable on PATH (portable `which`).
export function which(bin, path = process.env.PATH ?? '', { windows = IS_WINDOWS, pathext } = {}) {
  const exts = windows && !extname(bin) ? windowsExts(pathext) : [''];
  for (const dir of path.split(windows ? ';' : delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, bin + ext);
      try { accessSync(file, windows ? constants.F_OK : constants.X_OK); return file; } catch { /* keep looking */ }
    }
  }
  return null;
}

// npm writes `.cmd` shims that just run `node <script> %*`. Run the script with node directly, so
// arguments reach it unchanged (no cmd.exe quoting, newlines intact).
export function shimTarget(cmdFile, read = (f) => readFileSync(f, 'utf8')) {
  let text;
  try { text = read(cmdFile); } catch { return null; }
  const m = text.match(/"%~?dp0%?\\?([^"%]+\.[cm]?js)"/i);
  return m ? resolve(dirname(cmdFile), m[1].replace(/\\/g, '/')) : null;
}

// What to actually spawn for an executable found by `which`: { command, args }.
export function spawnTarget(file, args, { windows = IS_WINDOWS, read } = {}) {
  if (!windows || !/\.(cmd|bat)$/i.test(file)) return { command: file, args };
  const script = shimTarget(file, read);
  if (script) return { command: process.execPath, args: [script, ...args] };
  throw new Error(`${file} is a batch file Kraken cannot start safely (cmd.exe cuts multi-line prompts). ` +
    'Install the agent\'s native .exe, or put an npm-style shim on PATH.');
}

// Stop a process and everything it started. POSIX: the process group (the child was spawned
// detached, so its pid is the group id). Windows: taskkill /T walks the tree.
export function killTree(pid, signal = 'SIGTERM') {
  if (!(pid > 0)) return false; // never signal 0 / -1 (process groups of the caller)
  try {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else process.kill(-pid, signal);
    return true;
  } catch { return false; }
}

export function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A shell command line (verify), with the platform's shell: /bin/sh -c or cmd.exe /d /s /c.
export const runShell = (cmd, opts) => spawnSync(cmd, { shell: true, windowsHide: true, ...opts });

// Parent pid chain of `pid`, nearest first.
export function ancestors(pid = process.pid, max = 32, { windows = IS_WINDOWS } = {}) {
  const parentOf = windows ? windowsParents() : (p) => {
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

// One process-table snapshot (asking per pid would cost a PowerShell start each time).
function windowsParents() {
  const map = new Map();
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15_000 });
    for (const line of out.split(/\r?\n/)) {
      const [p, pp] = line.trim().split(/\s+/).map(Number);
      if (p) map.set(p, pp);
    }
  } catch { /* no PowerShell: no ancestry; KRAKEN_PARENT_RUN still works */ }
  return (p) => map.get(p) ?? 0;
}
