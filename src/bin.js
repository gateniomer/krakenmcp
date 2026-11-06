#!/usr/bin/env node
// `krakenmcp`            start the MCP server (stdio) — what MCP clients run
// `krakenmcp <command>`  developer CLI: doctor | show | list | edit | remove | mode | limit | prune
import './quiet.js'; // before anything loads node:sqlite (the rest is imported dynamically below)

const cmd = process.argv[2];
if (!cmd || cmd === 'serve') await import('./serve.js');
else await import('./cli.js');
