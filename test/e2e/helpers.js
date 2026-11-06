// Shared setup for end-to-end tests: a throwaway git repo and data dir per test file, the stub
// agent on PATH, and an MCP client that starts the real server through the `krakenmcp` entry point.
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const FAKEBIN = fileURLToPath(new URL('./fakebin', import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kraken-e2e-'));
  const repo = join(root, 'repo');
  const env = {
    ...process.env,
    PATH: `${FAKEBIN}${delimiter}${process.env.PATH}`,
    KRAKEN_DATA: join(root, 'data'),
    STUB_NODE: process.execPath, // the stub's shim must find node even when a test narrows PATH
    STUB_ARGS_LOG: join(root, 'args.log'),
    // merge commits need an identity; CI machines have none
    GIT_AUTHOR_NAME: 'kraken-test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'kraken-test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  for (const k of ['STUB_SLEEP', 'STUB_EXIT', 'STUB_QUESTION', 'STUB_FILE', 'STUB_COST', 'STUB_VERDICT', 'STUB_RESOLVE', 'STUB_PROVIDER_ERROR', 'STUB_LINES', 'STUB_LONG', 'STUB_TEXT', 'KRAKEN_MAX_PARALLEL']) delete env[k];

  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'math.js'), 'export const one = 1;\n');
  git('add', '.'); git('commit', '-qm', 'init');

  const cli = (...a) => execFileSync(process.execPath, [join(SRC, 'bin.js'), ...a],
    { encoding: 'utf8', env, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  // Tentacle files in the data dir, as a developer would write them. Claude Code may not be
  // installed: the base files point the tentacles that default to it at the stub.
  // tentacle(name, {settings, prompt?}) writes the file over the base; tentacle(name, null) restores it.
  const BASE = { think: { agent: 'opencode' }, plan: { agent: 'opencode' }, review: { agent: 'opencode' },
    research: { agent: 'opencode' } };
  const tentacleDir = join(env.KRAKEN_DATA, 'tentacles');
  mkdirSync(tentacleDir, { recursive: true });
  const tentacle = (name, settings) => {
    const file = join(tentacleDir, `${name}.md`);
    const all = settings === null ? BASE[name] : { ...BASE[name], ...settings };
    if (!all) { rmSync(file, { force: true }); return; }
    const { prompt = '', ...header } = all;
    writeFileSync(file, `---\n${Object.entries(header).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${prompt}\n`);
  };
  for (const t of Object.keys(BASE)) tentacle(t, null);

  let db;
  const h = {
    root, repo, env, git, cli, tentacle,
    db: () => (db ??= new DatabaseSync(join(env.KRAKEN_DATA, 'kraken.db'))),
    row: (id) => h.db().prepare('SELECT * FROM runs WHERE id = ?').get(id),
    argsLog: () => (existsSync(env.STUB_ARGS_LOG) ? readFileSync(env.STUB_ARGS_LOG, 'utf8').trim().split('\n') : []),
    clients: [],
    async client(extra = {}, name = 'e2e-client') {
      const c = new Client({ name, version: '0' });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(SRC, 'bin.js')], env: { ...env, ...extra } }));
      h.clients.push(c);
      const raw = async (tool, args = {}) => {
        const r = await c.callTool({ name: tool, arguments: args });
        return { isError: !!r.isError, text: r.content[0].text };
      };
      const call = async (tool, args = {}) => {
        const r = await raw(tool, args);
        if (r.isError) throw new Error(`${tool}: ${r.text}`);
        return JSON.parse(r.text);
      };
      // Same as call(), but with a progress token: returns the result and every progress notification.
      const callProgress = async (tool, args = {}) => {
        const notes = [];
        const r = await c.callTool({ name: tool, arguments: args }, undefined, { onprogress: (n) => notes.push(n) });
        if (r.isError) throw new Error(`${tool}: ${r.content[0].text}`);
        return { result: JSON.parse(r.content[0].text), notes };
      };
      const wait = async (id) => {
        for (;;) {
          const s = await call('status', { run_id: id, wait_seconds: 20 });
          if (!['queued', 'running'].includes(s.status)) return s;
        }
      };
      return { c, raw, call, callProgress, wait, close: () => c.close() };
    },
    async cleanup() {
      for (const c of h.clients) await c.close().catch(() => {});
      db?.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}

export const commitsOn = (h, branch) => h.git('log', '--oneline', `main..${branch}`).split('\n').filter(Boolean).length;
