// Manual smoke test of pipeline() with a REAL agent (spends tokens). Not part of npm test.
// Run: npm run test:smoke:pipeline -- <throwaway-git-repo> [agent] [verifyCmd]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [repo, agent = 'opencode', verify] = process.argv.slice(2);
const bin = new URL('../../src/bin.js', import.meta.url).pathname;
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env: process.env }));
const call = async (n, a) => { const r = await c.callTool({ name: n, arguments: a }, undefined, { timeout: 120000 }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
const oc = { agent };
const p = await call('pipeline', { task: 'Add a function mul(a, b) to math.js that multiplies, and a test line for it in test.mjs.', cwd: repo, verify, plan: oc, execute: oc, review: oc, session: 'smoke' });
let s;
for (;;) { s = await call('status', { run_id: p.pipeline_id, wait_seconds: 50 }); console.log(new Date().toISOString().slice(11,19), s.status, s.stage, s.current?.recent?.at(-1) ?? ''); if (s.status !== 'running') break; }
console.log('PIPELINE', JSON.stringify(s, null, 2));
for (const [k, id] of Object.entries(s.runs)) { if (!id) continue; const r = await call('status', { run_id: id }); console.log(k, id, r.status, JSON.stringify(r.metrics), r.verify ? JSON.stringify({ exit: r.verify.exit }) : ''); }
if (s.runs.execute) console.log('MERGE PREVIEW', JSON.stringify(await call('merge', { run_id: s.runs.execute }), null, 2));
console.log('STATS', JSON.stringify((await call('session', { session: 'smoke' })).total));
await c.close();
