#!/usr/bin/env node
// `krakenmcp`            start the MCP server (stdio) — what MCP clients run
// `krakenmcp <command>`  developer CLI: about | doctor | show | list | set | unset | reset | mode | limit | budget | log | prune | export | import | trust | untrust
import './quiet.js'; // before anything loads node:sqlite (the rest is imported dynamically below)

const cmd = process.argv[2];
if (!cmd || cmd === 'serve') await import('./serve.js');
else await import('./cli.js');
