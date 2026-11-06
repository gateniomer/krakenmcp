// Unit tests for agent adapters: command lines and output parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS, which } from '../../src/agents.js';

const { opencode, claude, codex } = AGENTS;

test('which finds executables on PATH only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraken-which-'));
  writeFileSync(join(dir, 'tool'), '#!/bin/sh\n'); chmodSync(join(dir, 'tool'), 0o755);
  writeFileSync(join(dir, 'plain'), 'x');
  assert.equal(which('tool', dir), join(dir, 'tool'));
  assert.equal(which('plain', dir), null);
  assert.equal(which('missing', dir), null);
});

test('opencode: read vs write mode, model, effort, resume', () => {
  assert.deepEqual(opencode.build('plan', { prompt: 'P' }),
    ['run', '--standalone', '--format', 'json', '--agent', 'plan', 'P']);
  assert.deepEqual(opencode.build('execute', { prompt: 'P', model: 'prov/m', effort: 'high' }),
    ['run', '--standalone', '--format', 'json', '-m', 'prov/m#high', '--auto', 'P']);
  assert.deepEqual(opencode.build('execute', { prompt: 'P', resumeSession: 'ses_1' }),
    ['run', '--standalone', '--format', 'json', '--session', 'ses_1', '--auto', 'P']);
});

test('opencode: parse events into text, tokens, cost, steps, tool calls', () => {
  const ev = (o) => JSON.stringify({ sessionID: 'ses_9', ...o });
  const out = [
    ev({ type: 'step_start', part: {} }),
    ev({ type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } }),
    ev({ type: 'tool_use', part: { tool: 'shell', state: { status: 'error' } } }),
    ev({ type: 'text', part: { text: 'Hello' } }),
    ev({ type: 'step_finish', part: { cost: 0.5, tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 100, write: 3 } } } }),
    ev({ type: 'step_finish', part: { cost: 0.25, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }),
    'not json',
  ].join('\n');
  const p = opencode.parse(out);
  assert.equal(p.text, 'Hello');
  assert.equal(p.nativeSession, 'ses_9');
  assert.deepEqual(p.tokens, { input: 11, output: 5, reasoning: 2, cache_read: 100, cache_write: 3 });
  assert.equal(p.cost, 0.75);
  assert.equal(p.steps, 2);
  assert.deepEqual(p.toolCalls, { total: 2, failed: 1, by_tool: { read: 1, shell: 1 } });
});

test('claude: flags and final JSON parsing', () => {
  assert.deepEqual(claude.build('plan', { prompt: 'P', model: 'opus' }),
    ['-p', 'P', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--permission-mode', 'plan']);
  assert.deepEqual(claude.budgetArgs(2), ['--max-budget-usd', '2']);
  assert.ok(claude.build('execute', { prompt: 'P', resumeSession: 's' }).join(' ').includes('--resume s'));
  assert.ok(claude.build('plan', { prompt: 'P', effort: 'high' }).join(' ').includes('--effort high'));
  const p = claude.parse(JSON.stringify({ result: 'R', session_id: 's1', total_cost_usd: 0.1, num_turns: 3,
    usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 } }));
  assert.equal(p.text, 'R');
  assert.deepEqual(p.tokens, { input: 5, output: 6, reasoning: 0, cache_read: 7, cache_write: 8 });
  assert.equal(p.steps, 3);
});

test('codex: sandbox follows access, effort via -c, resume subcommand', () => {
  const r = codex.build('plan', { prompt: 'P', lastMessageFile: '/tmp/x', effort: 'high' });
  assert.ok(r.includes('read-only'));
  assert.ok(r.includes('model_reasoning_effort="high"'));
  assert.ok(codex.build('execute', { prompt: 'P', lastMessageFile: '/tmp/x' }).includes('workspace-write'));
  assert.deepEqual(codex.build('execute', { prompt: 'P', lastMessageFile: '/tmp/x', resumeSession: 't1' }).slice(-3),
    ['resume', 't1', 'P']);
});

test('codex: parse --json events (turn usage, thread id, tool items) and the last-message file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraken-codex-'));
  const last = join(dir, 'last.txt');
  writeFileSync(last, 'Final answer\n');
  const out = [
    { type: 'thread.started', thread_id: 'th_1' },
    { type: 'item.completed', item: { id: '1', type: 'reasoning', text: 'hmm' } },
    { type: 'item.completed', item: { id: '2', type: 'command_execution', status: 'completed' } },
    { type: 'item.completed', item: { id: '3', type: 'command_execution', status: 'failed' } },
    { type: 'item.completed', item: { id: '4', type: 'file_change', status: 'completed' } },
    { type: 'item.completed', item: { id: '5', type: 'agent_message', text: 'Final answer' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 7 } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const p = codex.parse(out, last);
  assert.equal(p.text, 'Final answer');
  assert.equal(p.nativeSession, 'th_1');
  assert.deepEqual(p.tokens, { input: 100, output: 20, reasoning: 7, cache_read: 40, cache_write: 0 });
  assert.equal(p.steps, 1);
  assert.deepEqual(p.toolCalls, { total: 3, failed: 1, by_tool: { command_execution: 2, file_change: 1 } });
  assert.equal(codex.parse('plain output', join(dir, 'missing.txt')).text, 'plain output', 'falls back to stdout');
});

test('claude: unparseable output is kept as text instead of throwing', () => {
  const p = claude.parse('not json at all');
  assert.equal(p.text, 'not json at all');
  assert.equal(p.tokens, null);
});

test('cursor: ask mode for read, --force only for write, never auto-approves MCP servers', () => {
  const { cursor } = AGENTS;
  const read = cursor.build('plan', { prompt: 'P', model: 'gpt-x' });
  assert.deepEqual(read, ['-p', '--output-format', 'stream-json', '--trust', '--mode', 'ask', '--model', 'gpt-x', 'P']);
  const write = cursor.build('execute', { prompt: 'P', resumeSession: 'chat1' });
  assert.ok(write.includes('--force') && !write.includes('--mode'));
  assert.deepEqual(write.slice(-3), ['--resume', 'chat1', 'P']);
  for (const a of [read, write]) assert.ok(!a.includes('--approve-mcps'));
});

test('cursor: parse stream-json (result text, session, tool calls by kind, failures)', () => {
  const { cursor } = AGENTS;
  const out = [
    { type: 'system', subtype: 'init', session_id: 'c1', model: 'm' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }] }, session_id: 'c1' },
    { type: 'tool_call', subtype: 'started', call_id: '1', tool_call: { readToolCall: { args: { path: 'a' } } } },
    { type: 'tool_call', subtype: 'completed', call_id: '1', tool_call: { readToolCall: { args: {}, result: { success: { content: 'x' } } } } },
    { type: 'tool_call', subtype: 'completed', call_id: '2', tool_call: { writeToolCall: { args: {}, result: { error: { message: 'denied' } } } } },
    { type: 'tool_call', subtype: 'completed', call_id: '3', tool_call: { function: { name: 'grep', arguments: '{}' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] }, session_id: 'c1' },
    { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, result: 'Looking\nDone', session_id: 'c1' },
  ].map((e) => JSON.stringify(e)).join('\n');
  const p = cursor.parse(out);
  assert.equal(p.text, 'Looking\nDone');
  assert.equal(p.nativeSession, 'c1');
  assert.equal(p.steps, 2);
  assert.equal(p.tokens, null, 'Cursor reports no token counts');
  assert.deepEqual(p.toolCalls, { total: 3, failed: 1, by_tool: { read: 1, write: 1, grep: 1 } });
  assert.equal(cursor.onLine(JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: {} } })), 'tool: read');
});

test('binary lookup prefers cursor-agent over the generic agent name; checkAgents reports missing agents', async () => {
  const { findBin, checkAgents } = await import('../../src/agents.js');
  const dir = mkdtempSync(join(tmpdir(), 'kraken-bins-'));
  for (const b of ['agent', 'cursor-agent']) { writeFileSync(join(dir, b), '#!/bin/sh\necho "1.2.3"\n'); chmodSync(join(dir, b), 0o755); }
  assert.equal(findBin(AGENTS.cursor, dir), join(dir, 'cursor-agent'));
  const report = checkAgents(dir);
  assert.deepEqual(report.find((a) => a.name === 'cursor'), { name: 'cursor', installed: true, path: join(dir, 'cursor-agent'), version: '1.2.3' });
  const missing = report.find((a) => a.name === 'claude');
  assert.equal(missing.installed, false);
  assert.match(missing.install_docs, /^https:\/\//);
});

test('claude: stream-json events give text, tool counts, deduped usage and the budget stop', () => {
  const ev = [
    { type: 'system', subtype: 'init', session_id: 'sess9' },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Read' }], usage: { input_tokens: 10, output_tokens: 2 } } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Edit' }], usage: { input_tokens: 10, output_tokens: 2 } } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'All done' }], usage: { input_tokens: 5, output_tokens: 3 } } },
  ];
  const live = claude.parse(ev.map((e) => JSON.stringify(e)).join('\n'));
  assert.equal(live.text, 'All done', 'last assistant text while no result event yet');
  assert.equal(live.nativeSession, 'sess9');
  assert.deepEqual(live.tokens, { input: 15, output: 5, reasoning: 0, cache_read: 0, cache_write: 0 }, 'm1 counted once');
  assert.deepEqual(live.toolCalls, { total: 2, failed: 1, by_tool: { Read: 1, Edit: 1 } });
  const done = claude.parse([...ev, { type: 'result', subtype: 'error_max_budget_usd', result: 'stopped', session_id: 'sess9',
    total_cost_usd: 0.5, num_turns: 2, usage: { input_tokens: 99, output_tokens: 1 } }].map((e) => JSON.stringify(e)).join('\n'));
  assert.equal(done.cost, 0.5);
  assert.equal(done.tokens.input, 99, 'final usage wins');
  assert.equal(done.overBudget, true);
  assert.equal(claude.onLine(JSON.stringify(ev[1])), 'tool: Read');
});

test('aider: ask mode for read, history outside the worktree, tokens and cost from its text output', () => {
  const { aider } = AGENTS;
  const plan = aider.build('plan', { prompt: 'P', model: 'sonnet', effort: 'high', lastMessageFile: '/d/logs/run1.last.txt' });
  assert.ok(plan.join(' ').includes('--chat-mode ask'));
  assert.ok(plan.join(' ').includes('--chat-history-file /d/logs/run1.aider-chat.md'));
  assert.ok(plan.includes('--no-auto-commits') && plan.includes('--reasoning-effort'));
  const exec = aider.build('execute', { prompt: 'P', lastMessageFile: '/d/logs/run2.last.txt', resumeSession: '/d/logs/run1.aider-chat.md' });
  assert.ok(!exec.includes('ask') && exec.includes('--restore-chat-history'));
  assert.ok(exec.join(' ').includes('--chat-history-file /d/logs/run1.aider-chat.md'), 'a resumed run keeps the first history');
  const out = [
    'Aider v0.86.0', 'Main model: sonnet with diff edit format', 'Git repo: .git with 3 files', 'Repo-map: using 1024 tokens',
    'I changed math.js to export two.', 'Applied edit to math.js',
    'Tokens: 2.3k sent, 1.1k cache hit, 120 received. Cost: $0.0040 message, $0.0040 session.',
    'KRAKEN_QUESTION: keep one?',
  ].join('\n');
  const p = aider.parse(out, '/d/logs/run1.last.txt');
  assert.equal(p.text, 'I changed math.js to export two.\nKRAKEN_QUESTION: keep one?');
  assert.deepEqual(p.tokens, { input: 2300, output: 120, reasoning: 0, cache_read: 1100, cache_write: 0 });
  assert.equal(p.cost, 0.004);
  assert.deepEqual(p.toolCalls, { total: 1, failed: 0, by_tool: { edit: 1 } });
  assert.equal(p.nativeSession, '/d/logs/run1.aider-chat.md');
  assert.deepEqual(aider.ignore, ['.aider*']);
});

test('every adapter declares which metrics it reports', () => {
  for (const [name, a] of Object.entries(AGENTS)) {
    assert.deepEqual(Object.keys(a.reports ?? {}).sort(), ['cost', 'tokens', 'tool_calls'], name);
  }
  assert.equal(AGENTS.cursor.reports.cost, false);
});

test('agent error events and error results are surfaced', () => {
  const oc = AGENTS.opencode.parse(JSON.stringify({ type: 'error', error: { type: 'provider.auth', message: 'bad key' } }));
  assert.equal(oc.error, 'provider.auth: bad key');
  const cl = AGENTS.claude.parse(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }));
  assert.equal(cl.error, 'error_during_execution: boom');
});
