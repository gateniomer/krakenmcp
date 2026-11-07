// End to end: the live feed (status since / feed / cursor), with the stub agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let h;
before(() => { h = setup(); });
after(() => h.cleanup());

// Poll with a cursor until the run ends; returns every reply.
async function follow(c, id, since = 0) {
  const replies = [];
  for (;;) {
    const s = await c.call('status', { run_id: id, wait_seconds: 20, since });
    replies.push(s);
    since = s.cursor;
    if (!['queued', 'running'].includes(s.status)) return replies;
  }
}
const allLines = (replies) => replies.flatMap((r) => r.feed);

test('feed: labelled lines, a cursor that never repeats a line, and the end of the run', async () => {
  const c = await h.client({ STUB_SLEEP: '2' });
  const { run_id } = await c.call('explain', { area: 'feed', cwd: h.repo });
  const first = await c.call('status', { run_id, wait_seconds: 20, since: 0 });
  assert.ok(first.cursor > 0);
  assert.ok(first.feed.some((l) => /^explain tentacle \(opencode [^)]+\): started/.test(l)), first.feed.join('\n'));
  const rest = await follow(c, run_id, first.cursor);
  const lines = [...first.feed, ...allLines(rest)];
  assert.ok(lines.some((l) => l.includes('explain tentacle (opencode') && l.includes('"Done (resumed=no)."')), lines.join('\n'));
  assert.equal(new Set(lines).size, lines.length, 'no repeated lines');
  assert.match(lines.at(-1), /: done in [\d.]+s$/);
  await c.close();
});

test('feed: compact while running, full result with the last lines when done', async () => {
  const c = await h.client({ STUB_SLEEP: '4' });
  const { run_id } = await c.call('explain', { area: 'shape', cwd: h.repo });
  const running = await c.call('status', { run_id, wait_seconds: 1, since: 0 });
  assert.equal(running.status, 'running');
  for (const k of ['result', 'workdir', 'log']) assert.ok(!(k in running), `no ${k} while running`);
  assert.match(running.next, new RegExp(`since: ${running.cursor}`));
  const done = (await follow(c, run_id, running.cursor)).at(-1);
  assert.equal(done.status, 'done');
  assert.ok(done.result && done.workdir && done.log);
  assert.ok(done.feed.length > 0);
  const plain = await c.call('status', { run_id });
  assert.ok(!('feed' in plain) && plain.cursor > 0, 'without since the old shape plus a cursor');
  await c.close();
});

test('feed: a live summary headline and facts ride above the feed', async () => {
  const c = await h.client({ STUB_LINES: '3', STUB_SLEEP: '8' });
  const { run_id } = await c.call('explain', { area: 'summary', cwd: h.repo });
  let running = await c.call('status', { run_id, wait_seconds: 1, since: 0 });
  // The stub emits its events at once but startup timing varies; wait for all 6 tool lines.
  for (let i = 0; i < 5 && (running.summary?.tools?.total ?? 0) < 6; i++) {
    running = await c.call('status', { run_id, wait_seconds: 1, since: 0 });
  }
  assert.equal(running.status, 'running');
  const s = running.summary;
  assert.ok(s, 'a running reply carries a summary');
  const model = (h.row(run_id).model ?? 'default').split('/').at(-1);
  assert.ok(s.headline.startsWith(`[ 🦑 explain › opencode ${model} ]  ● running  `), s.headline);
  assert.ok(s.headline.includes('6 tools'), s.headline);
  assert.equal(s.tools.total, 6);
  assert.equal(s.tools.by_name.write, 6);
  assert.match(s.last_line, /^Done \(resumed=no\)\./);
  assert.equal(s.kind, 'run');
  assert.equal(s.status, 'running');
  assert.equal(s.milestones.verify, undefined, 'a read run has no verify milestone');
  assert.ok(s.elapsed_s >= 0);
  const done = (await follow(c, run_id, running.cursor)).at(-1);
  assert.match(done.summary.headline, /✓ done/);
  const plain = await c.call('status', { run_id });
  assert.ok(plain.summary, 'the full reply carries the summary too');
  await c.close();
});

test('feed: tool calls fold into one quiet line under the text line', async () => {
  const c = await h.client({ STUB_LINES: '3' });
  const { run_id } = await c.call('explain', { area: 'tools', cwd: h.repo });
  const lines = allLines(await follow(c, run_id));
  assert.equal(lines.filter((l) => l === '  · tools: write ×2').length, 3, lines.join('\n'));
  assert.ok(lines.some((l) => l.endsWith('"line 2"')));
  assert.ok(!lines.some((l) => /tool: write/.test(l)), 'never one line per call');
  await c.close();
});

test('feed: long text is cut at 200 chars, long feeds are capped with a marker', async () => {
  const c = await h.client({ STUB_LONG: '1' });
  const a = allLines(await follow(c, (await c.call('explain', { area: 'long', cwd: h.repo })).run_id));
  const long = a.find((l) => l.includes('"long x'));
  assert.match(long, /…"$/);
  assert.ok(long.split(': "')[1].length <= 202);
  await c.close();

  const d = await h.client({ STUB_LINES: '20' });
  const { run_id } = await d.call('explain', { area: 'many', cwd: h.repo });
  await d.wait(run_id);
  const s = await d.call('status', { run_id, since: 0 });
  assert.match(s.feed[0], /^\(\+\d+ earlier lines/);
  assert.ok(s.feed.length <= 13);
  const max = h.db().prepare('SELECT MAX(id) AS id FROM messages WHERE run_id = ?').get(run_id).id;
  assert.equal(s.cursor, max);
  await d.close();
});

test('feed: a question shows in the feed and the run is waiting', async () => {
  const c = await h.client({ STUB_QUESTION: '1' });
  const { run_id } = await c.call('explain', { area: 'ask', cwd: h.repo });
  const s = (await follow(c, run_id)).at(-1);
  assert.equal(s.status, 'waiting');
  assert.ok(s.feed.some((l) => l.endsWith('QUESTION: Keep it in a separate file?')), s.feed.join('\n'));
  const resumed = await c.call('resume', { run_id, input: 'Yes, a separate file' });
  await c.wait(resumed.run_id);
  const answered = await c.call('status', { run_id, since: 0 });
  assert.ok(answered.feed.some((l) => l.startsWith('developer: ANSWER: Yes, a separate file')),
    answered.feed.join('\n'));
  await c.close();
});

test('feed: agent text that starts with started/resumed stays quoted and complete', async () => {
  const c = await h.client({ STUB_TEXT: 'started looking at the parser' });
  const lines = allLines(await follow(c, (await c.call('explain', { area: 'text', cwd: h.repo })).run_id));
  assert.ok(lines.some((l) => l.endsWith('"started looking at the parser"')), lines.join('\n'));
  await c.close();
});

test('feed: the final reply reads past one 200-row page so nothing is dropped', async () => {
  const c = await h.client({ STUB_LINES: '80' }); // 3 messages per line = 240 rows, plus start and done
  const { run_id } = await c.call('explain', { area: 'manyrows', cwd: h.repo });
  await c.wait(run_id);
  const s = await c.call('status', { run_id, since: 0 });
  assert.match(s.feed[0], /^\(\+\d+ earlier lines/);
  assert.match(s.feed.at(-1), /: done in [\d.]+s$/);
  const max = h.db().prepare('SELECT MAX(id) AS id FROM messages WHERE run_id = ?').get(run_id).id;
  assert.equal(s.cursor, max);
  await c.close();
});

// Plan and execute set to auto, so the default chain runs straight through to the review.
const autoChain = (on) => { for (const t of ['plan', 'execute']) h.tentacle(t, on ? { autonomy: 'auto' } : null); };

test('feed: a running chain can be followed with since and progress notifications', async () => {
  autoChain(true);
  const c = await h.client({ STUB_SLEEP: '4' });
  const { chain_id } = await c.call('chain', { task: 'follow running', cwd: h.repo });
  const s = await c.call('status', { run_id: chain_id, wait_seconds: 5, since: 0 });
  assert.equal(s.status, 'running');
  assert.ok(s.cursor > 0, 'the running chain returns a cursor');
  assert.ok(Array.isArray(s.feed), 'a running chain returns a feed');
  assert.match(s.summary.headline, /^\[ 🦑 chain default › plan [✓●] → execute [·●] → review [·●] \]/);
  assert.match(s.summary.milestones.stages, /^\d of 3$/);
  const { notes } = await c.callProgress('status', { run_id: chain_id, wait_seconds: 3, since: s.cursor });
  assert.ok(notes.length > 0, 'progress notifications fire while waiting');
  await c.wait(chain_id);
  autoChain(false);
  await c.close();
});

test('feed: a chain labels lines with their stage and uses one cursor', async () => {
  autoChain(true);
  const c = await h.client();
  const { chain_id } = await c.call('chain', { task: 'feed chain', cwd: h.repo });
  const lines = allLines(await follow(c, chain_id));
  for (const stage of ['plan', 'execute', 'review']) {
    assert.ok(lines.some((l) => l.startsWith(`${stage} › ${stage} tentacle (`)), `${stage} in:\n${lines.join('\n')}`);
  }
  const plain = await c.call('status', { run_id: chain_id });
  assert.ok(plain.cursor > 0, 'a chain reply without since still carries a cursor');
  autoChain(false);
  await c.close();
});

test('status sends progress notifications while it waits', async () => {
  const c = await h.client({ STUB_SLEEP: '3' });
  const { run_id } = await c.call('explain', { area: 'progress', cwd: h.repo });
  const progress = [];
  const r = await c.c.callTool({ name: 'status', arguments: { run_id, wait_seconds: 20 } }, undefined,
    { onprogress: (p) => progress.push(p), timeout: 60_000 });
  assert.equal(JSON.parse(r.content[0].text).status, 'done');
  assert.ok(progress.length >= 1, 'got progress notifications');
  assert.match(progress[0].message, /^\[ 🦑 explain › opencode /);
  await c.close();
});
