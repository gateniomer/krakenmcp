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
  await c.close();
});

test('feed: a pipeline labels lines with their stage and uses one cursor', async () => {
  const c = await h.client();
  const { pipeline_id } = await c.call('pipeline', { task: 'feed pipeline', cwd: h.repo });
  const lines = allLines(await follow(c, pipeline_id));
  for (const stage of ['plan', 'execute', 'review']) {
    assert.ok(lines.some((l) => l.startsWith(`${stage} › ${stage} tentacle (`)), `${stage} in:\n${lines.join('\n')}`);
  }
  await c.close();
});
