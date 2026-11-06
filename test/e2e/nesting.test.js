// End to end: agents started by Kraken are told it is them doing the work, and a Kraken server
// started inside a Kraken run offers no tools (no agent -> agent -> agent chains).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let h;
before(() => { h = setup(); });
after(() => h.cleanup());

test('every agent gets KRAKEN_PARENT_RUN and the no-delegation instruction', async () => {
  const k = await h.client();
  const r = await k.wait((await k.call('explain', { area: 'x', cwd: h.repo })).run_id);
  assert.ok(h.argsLog().at(-1).startsWith(`parent=${r.id} `));
  assert.match(h.row(r.id).prompt, /Do not call Kraken tools or delegate to other agents/);
});

test('a server started with KRAKEN_PARENT_RUN exposes no tools and says why', async () => {
  const nested = await h.client({ KRAKEN_PARENT_RUN: 'run_parent' });
  assert.equal(nested.c.getServerCapabilities()?.tools, undefined);
  assert.match(nested.c.getInstructions(), /disabled here: this session is itself Kraken run run_parent/);
  assert.equal(nested.c.getServerVersion().title, 'Kraken (disabled)');
});

test('a server whose ancestor is a running Kraken agent is disabled even without the env marker', async () => {
  // Pretend this test process is the agent of a running run: the server we start is its child.
  const db = h.db();
  db.prepare(`INSERT INTO runs (id, session, tentacle, access, task, agent, cwd, workdir, status, agent_pid, created_at)
              VALUES ('run_fake', 's', 'plan', 'read', 't', 'opencode', ?, ?, 'running', ?, ?)`)
    .run(h.repo, h.repo, process.pid, new Date().toISOString());
  try {
    const nested = await h.client();
    assert.match(nested.c.getInstructions(), /itself Kraken run run_fake/);
  } finally {
    db.prepare("DELETE FROM runs WHERE id = 'run_fake'").run();
  }
  const normal = await h.client();
  assert.ok((await normal.c.listTools()).tools.length > 0, 'not disabled once that run is gone');
});

test('tentacles(check_agents) and doctor report installed agents, versions and the tentacles that need them', async () => {
  const k = await h.client();
  const quick = await k.call('tentacles', { cwd: h.repo });
  assert.equal(quick.agents.find((a) => a.name === 'opencode').version, undefined, 'no --version calls by default');
  const rep = await k.call('tentacles', { cwd: h.repo, check_agents: true });
  assert.deepEqual(rep.agents.map((a) => a.name), ['opencode', 'claude', 'codex', 'cursor', 'aider']);
  const oc = rep.agents.find((a) => a.name === 'opencode');
  assert.equal(oc.version, 'opencode stub 0.0.0');
  assert.deepEqual(oc.used_by.sort(), ['execute', 'explain', 'plan', 'research', 'review', 'think']);
  assert.equal(rep.agent_problems, undefined);

  // With only the stub and system tools on PATH, a tentacle on codex is reported as blocked.
  h.tentacle('review', { agent: 'codex' });
  const env = { ...h.env, PATH: `${new URL('./fakebin', import.meta.url).pathname}:/usr/bin:/bin` };
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [new URL('../../src/bin.js', import.meta.url).pathname, 'doctor'],
    { encoding: 'utf8', env, cwd: h.repo });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ok\s+opencode\s+opencode stub 0\.0\.0/m);
  assert.match(r.stdout, /^missing\s+codex\s+install: https:\/\/\S+\s+\(used by review\)/m);
  assert.match(r.stdout, /^problem\s+review use codex, which is not installed/m);
  h.tentacle('review', null);
});
