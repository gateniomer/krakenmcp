// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, with the parts of the protocol
// Kraken uses (tools, resource templates with subscriptions, logging, progress). Written here
// instead of depending on the MCP SDK, which brings an HTTP stack (express, hono, jose, ...) that a
// stdio server never loads. The e2e tests drive it with the official SDK client.
import { createInterface } from 'node:readline';
import { input, validate } from './schema.js';

// Newest first. A client asking for another version gets the newest; it may then disconnect.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
const ERR = { parse: -32700, invalid: -32600, method: -32601, params: -32602, internal: -32603 };

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function createServer({ info, instructions, tools: hasTools = true, out = process.stdout }) {
  const tools = new Map(), templates = [];
  const subscribed = new Set();
  let client = null, logLevel = 'info';

  const send = (msg) => out.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const notify = (method, params) => send({ method, params });

  const capabilities = { ...(hasTools && { tools: {}, resources: { subscribe: true } }), logging: {} };

  const handlers = {
    initialize: (p) => {
      client = p?.clientInfo ?? null;
      const protocolVersion = PROTOCOL_VERSIONS.includes(p?.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0];
      return { protocolVersion, capabilities, serverInfo: info, ...(instructions && { instructions }) };
    },
    ping: () => ({}),
    'logging/setLevel': (p) => {
      if (!LEVELS.includes(p?.level)) throw new RpcError(ERR.params, `level must be one of ${LEVELS.join(', ')}`);
      logLevel = p.level; return {};
    },
    'resources/list': () => ({ resources: [] }),
    'resources/templates/list': () => ({ resourceTemplates: templates.map(({ read, match, ...t }) => t) }),
    'resources/read': async (p) => {
      for (const t of templates) {
        const m = String(p?.uri ?? '').match(t.match);
        if (m) {
          try { return { contents: [await t.read(p.uri, m.groups ?? {})] }; }
          catch (e) { throw new RpcError(ERR.params, e.message); }
        }
      }
      throw new RpcError(ERR.params, `unknown resource ${p?.uri}`);
    },
    'resources/subscribe': (p) => { subscribed.add(p?.uri); server.onSubscribe?.(p?.uri); return {}; },
    'resources/unsubscribe': (p) => { subscribed.delete(p?.uri); return {}; },
  };
  if (hasTools) {
    handlers['tools/list'] = () => ({
      tools: [...tools.entries()].map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
    });
    handlers['tools/call'] = async (p, id) => {
      const t = tools.get(p?.name);
      if (!t) throw new RpcError(ERR.params, `unknown tool ${p?.name}`);
      let args;
      try { args = validate(t.inputSchema, p.arguments ?? {}); }
      catch (e) { return { content: [{ type: 'text', text: `Error: invalid input: ${e.message}` }], isError: true }; }
      const token = p?._meta?.progressToken;
      const ctx = {
        progress: token === undefined ? null
          : (progress, message) => notify('notifications/progress', { progressToken: token, progress, message }),
        requestId: id,
      };
      return t.handler(args, ctx);
    };
  }

  async function handle(msg) {
    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && 'id' in msg && !('result' in msg || 'error' in msg)) send({ id: msg.id ?? null, error: { code: ERR.invalid, message: 'invalid request' } });
      return; // responses to requests we never send, or garbage
    }
    const isRequest = 'id' in msg;
    const h = handlers[msg.method];
    if (!isRequest) return; // notifications: initialized, cancelled, roots changed ... nothing to do
    if (!h) return send({ id: msg.id, error: { code: ERR.method, message: `method not found: ${msg.method}` } });
    try {
      send({ id: msg.id, result: await h(msg.params, msg.id) });
    } catch (e) {
      send({ id: msg.id, error: { code: e instanceof RpcError ? e.code : ERR.internal, message: e.message } });
    }
  }

  const server = {
    tool(name, { description, input: props }, handler) {
      tools.set(name, { description, inputSchema: input(props), handler });
    },
    // match: a RegExp with named groups, run against the requested uri.
    resourceTemplate(t) { templates.push(t); },
    clientName: () => client?.name ?? 'unknown',
    isSubscribed: (uri) => subscribed.has(uri),
    onSubscribe: null,
    resourceUpdated: (uri) => notify('notifications/resources/updated', { uri }),
    log(level, logger, data) {
      if (LEVELS.indexOf(level) >= LEVELS.indexOf(logLevel)) notify('notifications/message', { level, logger, data });
    },
    handle,
    start(input = process.stdin) {
      const rl = createInterface({ input, crlfDelay: Infinity });
      const pending = new Set();
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: ERR.parse, message: 'parse error' } }); }
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
