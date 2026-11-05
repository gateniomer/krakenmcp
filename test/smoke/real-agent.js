// Manual smoke test with a REAL agent (spends tokens): drives the server over MCP like a client.
// Not part of npm test. Run: npm run test:smoke -- <throwaway-git-repo> "<task>" [planAgent] [execAgent] [verifyCmd]

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [repo, task, planAgent = 'opencode', execAgent = 'opencode', verify] = process.argv.slice(2);
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../../src/bin.js', import.meta.url).pathname] }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  if (r.isError) throw new Error(t);
  return JSON.parse(t);
};
const waitDone = async (id) => {
  for (;;) {
    const s = await call('status', { run_id: id, wait_seconds: 50 });
    console.log(`  ${id}: ${s.status} | ${s.recent_messages.map((m) => m.body.slice(0, 60)).join(' / ')}`);
    if (!['queued', 'running'].includes(s.status)) return s;
  }
};
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
console.log('agents:', (await call('tentacles', { cwd: repo })).agents.map((a) => `${a.name}=${a.installed}`).join(' '));
const p = await call('plan', { task, cwd: repo, agent: planAgent, session: 'smoke' });
const plan = await waitDone(p.run_id);
console.log('PLAN RESULT:\n' + plan.result + '\n' + (plan.error ?? ''));
if (plan.status !== 'done') process.exit(1);
const e = await call('execute', { plan_id: p.run_id, agent: execAgent, verify, session: 'smoke' });
const ex = await waitDone(e.run_id);
console.log('EXEC RESULT:\n' + ex.result + '\n' + (ex.error ?? ''));
console.log('plan metrics:', JSON.stringify(plan.metrics));
console.log('exec metrics:', JSON.stringify(ex.metrics));
console.log('verify:', JSON.stringify(ex.verify));
console.log('stats:', JSON.stringify((await call('session', { session: 'smoke' })).total));
console.log('worktree:', ex.workdir, 'branch:', ex.branch);
await client.close();
