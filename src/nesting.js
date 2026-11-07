// Detect a Kraken server started *inside* a Kraken run (a child agent that has Kraken in its own MCP
// config). Such a server must not offer tools, or agents could delegate to agents without limit.
//
// Two signals, because MCP clients often start servers with a stripped-down environment:
//   1. KRAKEN_PARENT_RUN, set by the worker on every agent it starts;
//   2. the process ancestry: is any ancestor the worker or agent process of a running run?
import { db } from './store.js';
import { ancestors } from './platform.js';

// Returns the id of the Kraken run this process is nested in, or null.
export function nestedRun({ env = process.env, chain = ancestors() } = {}) {
  if (env.KRAKEN_PARENT_RUN) return env.KRAKEN_PARENT_RUN;
  if (!chain.length) return null;
  const marks = chain.map(() => '?').join(',');
  const row = db.prepare(`SELECT id FROM runs
    WHERE status = 'running' AND (agent_pid IN (${marks}) OR pid IN (${marks})) LIMIT 1`)
    .get(...chain, ...chain);
  return row?.id ?? null;
}
