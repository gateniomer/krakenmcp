// Verified against opencode v2.2.5 (event shapes taken from real run logs).
import { jsonLines, emptyTokens, countTools } from './util.js';

export default {
  bin: 'opencode',
  docs: 'https://opencode.ai/docs/cli/',
  defaultModel: { read: null, write: null }, // use opencode's configured default model
  effortNote: 'appended as model#variant (e.g. "high" -> provider/model#high); needs an explicit model',
  reports: { cost: true, tokens: true, tool_calls: true },
  build(access, { prompt, model, effort, resumeSession }) {
    // --standalone gives each run a private server, so it never depends on (or collides with)
    // the developer's background `opencode serve --service`.
    const args = ['run', '--standalone', '--format', 'json'];
    if (model) args.push('-m', effort ? `${model}#${effort}` : model);
    if (resumeSession) args.push('--session', resumeSession); // verified flag: continue a session
    if (access === 'read') args.push('--agent', 'plan'); // built-in read-only agent
    else args.push('--auto');                          // auto-approve edits (runs in a worktree)
    args.push(prompt);
    return args;
  },
  parse(stdout) {
    const events = jsonLines(stdout);
    const text = events.filter((e) => e.type === 'text').map((e) => e.part?.text ?? '').join('\n').trim();
    const tokens = emptyTokens();
    let cost = 0, steps = 0;
    for (const e of events) {
      if (e.type !== 'step_finish') continue;
      steps++;
      cost += e.part?.cost || 0;
      const t = e.part?.tokens || {};
      tokens.input += t.input || 0; tokens.output += t.output || 0; tokens.reasoning += t.reasoning || 0;
      tokens.cache_read += t.cache?.read || 0; tokens.cache_write += t.cache?.write || 0;
    }
    const tools = events.filter((e) => e.type === 'tool_use');
    const failed = tools.filter((e) => e.part?.state?.status && e.part.state.status !== 'completed').length;
    // Provider failures (network, auth, quota) arrive as error events on stdout, not stderr.
    const errorText = (e) => [e.error?.type, e.error?.message ?? e.message].filter(Boolean).join(': ');
    const errors = events.filter((e) => e.type === 'error').map(errorText);
    return {
      text, tokens, cost, steps,
      error: errors.length ? errors.at(-1) : undefined,
      nativeSession: events.find((e) => e.sessionID)?.sessionID ?? null,
      toolCalls: countTools(tools.map((e) => e.part?.tool ?? 'unknown'), failed),
    };
  },
  onLine(line) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'tool_use') return `tool: ${e.part?.tool ?? 'unknown'}`;
      if (e.type === 'text' && e.part?.text) return e.part.text.slice(0, 300);
    } catch {}
    return null;
  },
};
