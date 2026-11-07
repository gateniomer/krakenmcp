// Cursor CLI. Flags and stream-json events checked against cursor.com/docs/cli (reference/parameters,
// reference/output-format); not yet run against a real CLI. Its output has no token counts or cost.
import { jsonLines, countTools } from './util.js';

export default {
  // The installer provides both; `agent` is a generic name, so prefer cursor-agent.
  bin: ['cursor-agent', 'agent'],
  docs: 'https://cursor.com/docs/cli',
  defaultModel: { read: null, write: null }, // use Cursor's configured default
  effortNote: 'not supported by the Cursor CLI; ignored',
  reports: { cost: false, tokens: false, tool_calls: true },
  build(access, { prompt, model, resumeSession }) {
    // ask = read-only Q&A mode; --force allows edits without confirmation; --trust skips the
    // workspace-trust prompt (headless only). --approve-mcps is deliberately NOT passed.
    const args = ['-p', '--output-format', 'stream-json', '--trust'];
    args.push(...(access === 'read' ? ['--mode', 'ask'] : ['--force']));
    if (model) args.push('--model', model);
    if (resumeSession) args.push('--resume', resumeSession);
    args.push(prompt);
    return args;
  },
  parse(stdout) {
    const events = jsonLines(stdout);
    const result = events.find((e) => e.type === 'result');
    const text = (result?.result ?? events.filter((e) => e.type === 'assistant')
      .flatMap((e) => e.message?.content ?? []).map((c) => c.text ?? '').join('')).trim();
    const done = events.filter((e) => e.type === 'tool_call' && e.subtype === 'completed');
    const toolName = (tc = {}) => {
      const key = Object.keys(tc)[0] ?? 'unknown';
      return key === 'function' ? tc.function?.name ?? 'function' : key.replace(/ToolCall$/, '');
    };
    const failedCall = (e) => {
      const v = Object.values(e.tool_call ?? {})[0];
      return v?.result && !v.result.success;
    };
    const failed = done.filter(failedCall);
    return {
      text, tokens: null, cost: null,
      steps: events.filter((e) => e.type === 'assistant').length || null,
      nativeSession: result?.session_id ?? events.find((e) => e.session_id)?.session_id ?? null,
      toolCalls: countTools(done.map((e) => toolName(e.tool_call)), failed.length),
    };
  },
  onLine(line) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'tool_call' && e.subtype === 'started') {
        const key = Object.keys(e.tool_call ?? {})[0] ?? 'unknown';
        return `tool: ${key === 'function' ? e.tool_call.function?.name : key.replace(/ToolCall$/, '')}`;
      }
      if (e.type === 'assistant') {
        return (e.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 300) || null;
      }
    } catch {}
    return null;
  },
};
