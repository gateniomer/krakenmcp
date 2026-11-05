// The MCP server a nested Kraken (inside a Kraken run) starts instead of the real one: no tools.
import { createServer } from './mcp.js';
import { VERSION } from './about.js';

export function startDisabled(parentRun) {
  createServer({
    info: { name: 'kraken', title: 'Kraken (disabled)', version: VERSION },
    instructions: `Kraken is disabled here: this session is itself Kraken run ${parentRun}. ` +
      'Do the task yourself; do not delegate it to other agents.',
    tools: false,
  }).start();
}
