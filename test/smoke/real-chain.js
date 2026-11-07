// Manual smoke test of chain() with a REAL agent (spends tokens). Not part of npm test.
// Run: npm run test:smoke:chain -- <throwaway-git-repo> [agent] [verifyCmd]
// The default chain pauses after each stage whose autonomy is ask; this script answers each pause
// with "go on", like a developer approving every step.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [repo, agent = 'opencode', verify] = process.argv.slice(2);
const bin = new URL('../../src/bin.js', import.meta.url).pathname;
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env: process.env }));
const call = async (n, a) => { const r = await c.callTool({ name: n, arguments: a }, undefined, { timeout: 120000 }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
const overrides = ['plan', 'execute', 'review'].map((stage) => ({ stage, agent }));
const p = await call('chain', { task: 'Add a function mul(a, b) to math.js that multiplies, and a test line for it in test.mjs.', cwd: repo, verify, overrides, session: 'smoke' });
let s;
for (;;) {
  s = await call('status', { run_id: p.chain_id, wait_seconds: 50 });
  console.log(new Date().toISOString().slice(11, 19), s.status, s.stage, s.current?.recent?.at(-1) ?? '');
  if (s.status === 'waiting' && s.pause) { console.log('PAUSED', s.next); await call('resume', { run_id: p.chain_id, input: 'go on' }); continue; }
  if (s.status !== 'running') break;
}
console.log('CHAIN', JSON.stringify(s, null, 2));
for (const [k, id] of Object.entries(s.runs)) { const r = await call('status', { run_id: id }); console.log(k, id, r.status, JSON.stringify(r.metrics), r.verify ? JSON.stringify({ exit: r.verify.exit }) : ''); }
if (s.branch_run) console.log('MERGE PREVIEW', JSON.stringify(await call('merge', { run_id: s.branch_run }), null, 2));
console.log('STATS', JSON.stringify((await call('session', { session: 'smoke' })).total));
await c.close();
