// Aider. Flags checked against aider.chat/docs/config/options.html; not yet run against a real CLI.
// Plain-text output: tokens and cost come from its "Tokens: … Cost: …" lines. Aider has no session
// id; its chat history file (kept in Kraken's logs, not in the worktree) is the session to resume.
import { emptyTokens, countTools } from './util.js';

export default {
  bin: 'aider',
  docs: 'https://aider.chat/docs/config/options.html',
  defaultModel: { read: null, write: null }, // use aider's configured default
  effortNote: 'passed as --reasoning-effort <effort>',
  reports: { cost: true, tokens: true, tool_calls: false },
  ignore: ['.aider*'],
  build(access, { prompt, model, effort, lastMessageFile, resumeSession }) {
    const history = aiderHistory(lastMessageFile, resumeSession);
    const args = ['--message', prompt, '--yes-always', '--no-auto-commits', '--no-pretty', '--no-stream',
      '--no-check-update', '--no-show-release-notes', '--no-analytics', '--no-gitignore',
      '--chat-history-file', history, '--input-history-file', `${history}.input`];
    if (access === 'read') args.push('--chat-mode', 'ask'); // answers questions, never edits
    if (model) args.push('--model', model);
    if (effort) args.push('--reasoning-effort', effort);
    if (resumeSession) args.push('--restore-chat-history');
    return args;
  },
  parse(stdout, lastMessageFile, { resumeSession } = {}) {
    const lines = stdout.split(/\r?\n/);
    const tokens = emptyTokens();
    let cost = null, steps = 0;
    for (const l of lines) {
      const t = l.match(/^Tokens:\s*(.+?)(?:\.\s*Cost:|$)/);
      if (t) {
        steps++;
        for (const part of t[1].split(',')) {
          const m = part.trim().match(/^([\d.]+)([kKmM]?)\s+(sent|received|cache write|cache hit)/);
          if (!m) continue;
          const n = Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] ?? 1));
          tokens[{ sent: 'input', received: 'output', 'cache write': 'cache_write', 'cache hit': 'cache_read' }[m[3]]] += n;
        }
      }
      const c = l.match(/Cost:\s*\$([\d.]+)\s+message/);
      if (c) cost = (cost ?? 0) + Number(c[1]);
    }
    const edits = lines.filter((l) => /^Applied edit to /.test(l)).length;
    const text = lines.filter((l) => !NOISE.test(l)).join('\n').trim();
    return { text, tokens: steps ? tokens : null, cost, steps: steps || null,
      nativeSession: aiderHistory(lastMessageFile, resumeSession),
      toolCalls: edits ? countTools(Array(edits).fill('edit')) : null };
  },
  onLine(line) {
    return /^Applied edit to /.test(line) ? line.trim() : null;
  },
};

// Aider's chat history lives next to the run's log; a resumed run keeps using the first run's file.
const aiderHistory = (lastMessageFile, resumeSession) =>
  resumeSession ?? lastMessageFile.replace(/\.last\.txt$/, '.aider-chat.md');
const NOISE = /^(Aider v|Main model:|Weak model:|Editor model:|Git repo:|Repo-map:|Model:|Added .+ to the chat|Tokens:|Cost:|Applied edit to |Commit [0-9a-f]{6,}|Use \/help|https:\/\/aider\.chat|Restored previous conversation history|Can't initialize prompt toolkit|─+\s*$)/;
