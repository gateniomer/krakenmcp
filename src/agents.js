// Agent registry. Each adapter lives in src/agents/<name>.js and implements:
// build(kind, {prompt, model, effort, lastMessageFile, resumeSession}) -> argv
//   resumeSession: continue that native agent session (resume / answer) instead of starting fresh
// parse(stdout, lastMessageFile, {resumeSession}) -> normalized result:
//   { text, nativeSession, tokens: {input, output, reasoning, cache_read, cache_write},
//     cost, steps, toolCalls: {total, failed, by_tool}, overBudget?, error? (the agent's own error message) }
//   The worker also calls parse on the partial output while the agent runs, to enforce budgets.
// onLine(line) -> optional progress text for the messages table
// reports: which metrics the agent's output contains ({cost, tokens, tool_calls}); budgets on a
//   metric the agent does not report cannot be enforced, and stats say so.
// budgetArgs(maxCostUsd) -> extra argv, for agents that can enforce a spend cap themselves.
// ignore: pathspecs Kraken leaves out of commits (files the agent writes for itself).

import { spawnSync } from 'node:child_process';
import { which, spawnTarget } from './platform.js';
import opencode from './agents/opencode.js';
import claude from './agents/claude.js';
import codex from './agents/codex.js';
import cursor from './agents/cursor.js';
import aider from './agents/aider.js';

export { which };

// To add an agent: write src/agents/<name>.js (see the contract above) and list it here.
export const AGENTS = { opencode, claude, codex, cursor, aider };

const binsOf = (a) => (Array.isArray(a.bin) ? a.bin : [a.bin]);
export const findBin = (a, path) => binsOf(a).map((b) => which(b, path)).find(Boolean) ?? null;

export function agentInfo() {
  return Object.entries(AGENTS).map(([name, a]) => ({
    name, installed: !!findBin(a), path: findBin(a), defaultModel: a.defaultModel, effort: a.effortNote, reports: a.reports,
  }));
}

export function resolveAgent(name) {
  const a = AGENTS[name];
  if (!a) throw new Error(`Unknown agent "${name}". Known: ${Object.keys(AGENTS).join(', ')}`);
  const path = findBin(a);
  if (!path) throw new Error(`Agent "${name}" is not installed (no ${binsOf(a).map((b) => `"${b}"`).join(' or ')} on PATH).`);
  return { ...a, path, spawn: (args) => spawnTarget(path, args) };
}

// Health check for `agents` (MCP) and `krakenmcp doctor`: install state, path, version, docs.
// Login is not checked: that needs a real (paid) agent call.
export function checkAgents(path = process.env.PATH) {
  return Object.entries(AGENTS).map(([name, a]) => {
    const bin = findBin(a, path);
    if (!bin) return { name, installed: false, looked_for: binsOf(a), install_docs: a.docs };
    let r;
    try {
      const { command, args } = spawnTarget(bin, ['--version']);
      r = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { r = { status: null, error: e }; }
    const version = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').map((l) => l.trim()).find(Boolean) ?? null;
    return { name, installed: true, path: bin, version: r.status === 0 ? version : null,
      ...(r.status === 0 ? {} : { problem: `"${bin} --version" failed${r.error ? `: ${r.error.message}` : ''}` }) };
  });
}
