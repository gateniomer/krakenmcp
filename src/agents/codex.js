// Flags and --json events checked against the Codex non-interactive docs; not yet run against a
// real CLI. Unverified detail: exec-level flags are placed before the `resume` subcommand.
import { readFileSync, existsSync } from 'node:fs';
import { jsonLines, emptyTokens, countTools } from './util.js';

export default {
  bin: 'codex',
  docs: 'https://github.com/openai/codex',
  defaultModel: { read: null, write: null }, // use codex's configured default
  effortNote: 'passed as -c model_reasoning_effort=<effort>',
  reports: { cost: false, tokens: true, tool_calls: true },
  build(access, { prompt, model, effort, lastMessageFile, resumeSession }) {
    const args = ['exec', '--json', '--skip-git-repo-check',
      '--sandbox', access === 'read' ? 'read-only' : 'workspace-write',
      '--output-last-message', lastMessageFile];
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    if (resumeSession) args.push('resume', resumeSession); // `codex exec resume <SESSION_ID> [PROMPT]`
    args.push(prompt);
    return args;
  },
  parse(stdout, lastMessageFile) {
    const events = jsonLines(stdout);
    const text = existsSync(lastMessageFile) ? readFileSync(lastMessageFile, 'utf8').trim() : stdout.trim();
    const tokens = emptyTokens();
    const turns = events.filter((e) => e.type === 'turn.completed');
    for (const { usage: u = {} } of turns) {
      tokens.input += u.input_tokens || 0; tokens.output += u.output_tokens || 0;
      tokens.reasoning += u.reasoning_output_tokens || 0; tokens.cache_read += u.cached_input_tokens || 0;
    }
    const items = events.filter((e) => e.type === 'item.completed' && e.item && e.item.type !== 'agent_message' && e.item.type !== 'reasoning');
    return {
      text, tokens, cost: null, steps: turns.length || null,
      nativeSession: events.find((e) => e.type === 'thread.started')?.thread_id ?? null,
      toolCalls: countTools(items.map((e) => e.item.type), items.filter((e) => e.item.status === 'failed').length),
    };
  },
  onLine() { return null; },
};
