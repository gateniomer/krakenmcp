// Flags from the Claude Code CLI reference (code.claude.com/docs/en/cli-reference). stream-json
// (needs --verbose in print mode) gives one event per message, so tool calls can be counted and
// usage read while the run is going.
import { jsonLines, emptyTokens, countTools } from './util.js';

export default {
  bin: 'claude',
  docs: 'https://code.claude.com/docs/en/cli-reference',
  defaultModel: { read: 'opus', write: 'sonnet' },
  effortNote: 'passed as --effort <low|medium|high|xhigh|max> (levels depend on the model)',
  reports: { cost: true, tokens: true, tool_calls: true },
  budgetArgs: (usd) => ['--max-budget-usd', String(usd)],
  build(access, { prompt, model, effort, resumeSession }) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (resumeSession) args.push('--resume', resumeSession);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push('--permission-mode', access === 'read' ? 'plan' : 'acceptEdits');
    return args;
  },
  parse(stdout) {
    const events = jsonLines(stdout);
    // stream-json ends with a "result" event; plain --output-format json is that object alone.
    const result = events.findLast((e) => e.type === 'result' || (e.type === undefined && 'result' in e));
    // One API response arrives as several assistant events (one per content block) that share the
    // message id and repeat its usage: merge the blocks, count the usage once.
    const messages = new Map();
    for (const e of events) {
      if (e.type !== 'assistant' || !e.message) continue;
      const key = e.message.id ?? `#${messages.size}`;
      const prev = messages.get(key);
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      const merged = prev ? { ...prev, content: [...prev.content, ...content] } : { ...e.message, content };
      messages.set(key, merged);
    }
    const blocks = (m) => (Array.isArray(m.content) ? m.content : []);
    const textOf = (m) => blocks(m).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const lastText = [...messages.values()].reverse().map(textOf).find(Boolean) ?? '';
    const tokens = emptyTokens();
    const add = (u = {}) => {
      tokens.input += u.input_tokens || 0; tokens.output += u.output_tokens || 0;
      tokens.cache_read += u.cache_read_input_tokens || 0;
      tokens.cache_write += u.cache_creation_input_tokens || 0;
    };
    if (result?.usage) add(result.usage); else for (const m of messages.values()) add(m.usage);
    const toolsOf = (m) => blocks(m).filter((b) => b.type === 'tool_use').map((b) => b.name ?? 'unknown');
    const toolNames = [...messages.values()].flatMap(toolsOf);
    const failed = events.filter((e) => e.type === 'user').flatMap((e) => blocks(e.message ?? {}))
      .filter((b) => b.type === 'tool_result' && b.is_error).length;
    const none = { nativeSession: null, tokens: null, cost: null, steps: null, toolCalls: null };
    if (!events.length) return { text: stdout.trim(), ...none };
    return {
      text: (result?.result ?? lastText).trim(),
      nativeSession: result?.session_id ?? events.find((e) => e.session_id)?.session_id ?? null,
      tokens, cost: result?.total_cost_usd ?? null, steps: result?.num_turns ?? (messages.size || null),
      toolCalls: countTools(toolNames, failed),
      overBudget: /budget/i.test(result?.subtype ?? ''),
      error: result?.is_error ? [result.subtype ?? 'error', result.result].filter(Boolean).join(': ')
        : undefined,
    };
  },
  onLine(line) {
    try {
      const e = JSON.parse(line);
      if (e.type !== 'assistant') return null;
      const b = (e.message?.content ?? [])[0];
      if (b?.type === 'tool_use') return `tool: ${b.name}`;
      if (b?.type === 'text' && b.text) return b.text.slice(0, 300);
    } catch {}
    return null;
  },
};
