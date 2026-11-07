#!/usr/bin/env node
// `krakenmcp`            start the MCP server (stdio) — what MCP clients run
// `krakenmcp <command>`  developer CLI: doctor | show | list | edit | remove | mode | limit | prune | update
// `krakenmcp --version`  print the installed version (no DB or data dir is touched)
import './quiet.js'; // before anything loads node:sqlite (the rest is imported dynamically below)
import { readFileSync } from 'node:fs';

const cmd = process.argv[2];
if (['version', '--version', '-v'].includes(cmd)) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
} else if (!cmd || cmd === 'serve') await import('./serve.js');
else await import('./cli.js');
