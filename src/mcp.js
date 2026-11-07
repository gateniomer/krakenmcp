// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, with the parts of the protocol
// Kraken uses (tools and progress). Written here
// instead of depending on the MCP SDK, which brings an HTTP stack (express, hono, jose, ...) that a
// stdio server never loads. The e2e tests drive it with the official SDK client.
import { createInterface } from 'node:readline';
import { input, validate } from './schema.js';

// Newest first. A client asking for another version gets the newest; it may then disconnect.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ERR = { parse: -32700, invalid: -32600, method: -32601, params: -32602, internal: -32603 };

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function createServer({ info, instructions, tools: hasTools = true, out = process.stdout }) {
  const tools = new Map();

  const send = (msg) => out.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const notify = (method, params) => send({ method, params });
  const sendError = (id, code, message) => send({ id, error: { code, message } });
  const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

  const capabilities = hasTools ? { tools: {} } : {};

  const handlers = {
    initialize: (p) => {
      const asked = p?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return { protocolVersion, capabilities, serverInfo: info, ...(instructions && { instructions }) };
    },
    ping: () => ({}),
  };
  if (hasTools) {
    handlers['tools/list'] = () => ({
      tools: [...tools.entries()]
        .map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
    });
    handlers['tools/call'] = async (p) => {
      const t = tools.get(p?.name);
      if (!t) throw new RpcError(ERR.params, `unknown tool ${p?.name}`);
      let args;
      try { args = validate(t.inputSchema, p.arguments ?? {}); }
      catch (e) { return errorResult(`Error: invalid input: ${e.message}`); }
      const token = p?._meta?.progressToken;
      const ctx = {
        progress: token === undefined ? null
          : (progress, message) =>
            notify('notifications/progress', { progressToken: token, progress, message }),
      };
      return t.handler(args, ctx);
    };
  }

  async function handle(msg) {
    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // A response to a request we never send, or garbage. Only a malformed request gets an answer.
      const badRequest = msg && 'id' in msg && !('result' in msg || 'error' in msg);
      if (badRequest) sendError(msg.id ?? null, ERR.invalid, 'invalid request');
      return;
    }
    const isRequest = 'id' in msg;
    const h = handlers[msg.method];
    if (!isRequest) return; // notifications: initialized, cancelled, roots changed ... nothing to do
    if (!h) return sendError(msg.id, ERR.method, `method not found: ${msg.method}`);
    try {
      send({ id: msg.id, result: await h(msg.params) });
    } catch (e) {
      sendError(msg.id, e instanceof RpcError ? e.code : ERR.internal, e.message);
    }
  }

  const server = {
    tool(name, { description, input: props }, handler) {
      tools.set(name, { description, inputSchema: input(props), handler });
    },
    handle,
    start(input = process.stdin) {
      const rl = createInterface({ input, crlfDelay: Infinity });
      const pending = new Set();
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return sendError(null, ERR.parse, 'parse error'); }
        for (const m of Array.isArray(msg) ? msg : [msg]) {
          const p = handle(m).catch(() => {}).finally(() => pending.delete(p));
          pending.add(p);
        }
      });
      // The client hung up: answer what is already in flight, then exit once stdout is flushed.
      rl.on('close', async () => {
        await Promise.all(pending);
        out.write('', () => process.exit(0));
      });
    },
  };
  return server;
}
