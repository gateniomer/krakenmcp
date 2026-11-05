// Tentacles: named actions (plan, execute, or custom) with layered settings.
// Resolution order, last wins: built-in -> global -> repo -> call arguments.
// A repository can also check in .kraken/tentacles.json (the `krakenmcp export` format) for its team.
// That file can set `verify` (a shell command) and prompts, so it is only used after the developer
// trusts it (`krakenmcp trust`), which records the file's hash; any change needs trusting again.
// Tentacles are also .md files: built-ins in src/tentacles/, the developer's own in ~/.kraken/tentacles/,
// a repo's in .kraken/tentacles/ (trusted like the JSON file).
// Full order: built-in -> user file -> global -> repo files (trusted) -> repo -> call arguments.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents.js';
import { DATA_DIR, getTentacleRow, tentacleRows, saveTentacleRow, deleteTentacleRow, getSetting, setSetting } from './store.js';

export const FIELDS = {
  description: 'string',
  access: ['read', 'write'],
  agent: Object.keys(AGENTS),
  model: 'string|null',      // null = the agent's default model
  effort: 'string|null',
  prompt: 'string',          // template: {{task}} {{plan}} {{context}} {{diff}} {{workdir}} {{repo}}
  isolation: ['worktree', 'none'],
  verify: 'string|null',     // shell command Kraken runs after a write tentacle
  timeout_min: 'number',
  max_cost_usd: 'number|null', // stop the run when its cost passes this (agents that report cost)
  max_tokens: 'number|null',   // stop the run when input + output + reasoning tokens pass this
  reuse_session_min: 'number|null', // read tentacles: continue the same tentacle's agent session if it finished this recently
};

// Defaults for every tentacle file; a custom tentacle must set at least `prompt`.
const CUSTOM_BASE = {
  description: '', access: 'read', agent: 'opencode', model: null, effort: null,
  isolation: 'none', verify: null, timeout_min: 30, max_cost_usd: null, max_tokens: null, reuse_session_min: null,
};

// ---- tentacle files: <name>.md with a "---" settings header, then the prompt ----
//
//   ---
//   description: Audit dependencies for known problems
//   access: read
//   agent: claude
//   ---
//   You are the AUDITOR. ... {{task}}
//
// Header values are parsed as JSON when possible (null, numbers, true/false), otherwise kept as strings.
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const headerValue = (v) => { try { return JSON.parse(v); } catch { return v; } };

export function parseTentacleFile(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) throw new Error('expected a "---" settings header, a closing "---", then the prompt');
  const settings = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 1) throw new Error(`bad header line "${line}" (expected key: value)`);
    settings[line.slice(0, i).trim()] = headerValue(line.slice(i + 1).trim());
  }
  if ('prompt' in settings) throw new Error('the prompt goes after the header, not in it');
  const prompt = (m[2] ?? '').trim();
  if (prompt) settings.prompt = prompt;
  validate(settings);
  return settings;
}

// Every <name>.md in dir: { tentacles: {name: settings}, problems: [..], files: [paths] }.
// A broken file is skipped and reported; it never hides the other tentacles.
export function loadTentacleDir(dir, files = readTentacleDir(dir)) {
  const out = { tentacles: {}, problems: [], files: files.map((f) => f.path) };
  for (const { name, path, text } of files) {
    if (!NAME.test(name)) { out.problems.push(`${path}: file name must be lowercase letters, digits, - or _ (max 32)`); continue; }
    try { out.tentacles[name] = parseTentacleFile(text); }
    catch (e) { out.problems.push(`${path}: ${e.message}`); }
  }
  return out;
}
const readTentacleDir = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  .map((f) => ({ name: f.slice(0, -3), path: join(dir, f), text: readFileSync(join(dir, f), 'utf8') })) : []);

// Built-ins ship as files next to this module; edit them there.
export const BUILTIN_DIR = fileURLToPath(new URL('./tentacles/', import.meta.url));
export const BUILTIN = Object.fromEntries(Object.entries(loadTentacleDir(BUILTIN_DIR).tentacles)
  .map(([n, t]) => [n, { ...CUSTOM_BASE, ...t }]));
// The developer's own tentacle files (trusted: they live in the developer's data dir).
export const userDir = () => join(DATA_DIR, 'tentacles');
export const userTentacles = () => loadTentacleDir(userDir());

// Fixed preamble per access level. Prompts can change what a tentacle does, not what it may do.
const PREAMBLE = {
  read: 'You have READ-ONLY access. Do not create, edit or delete any files.',
  write: 'Your working directory is {{workdir}}. All paths are relative to it. ' +
    'Never read or edit files outside this directory, even if the instructions mention another absolute path.',
};
// Same for every tentacle: how an agent asks the developer instead of guessing (status 'waiting').
const ASK = 'You are a Kraken sub-agent: do this task yourself. Do not call Kraken tools or delegate to other agents. ' +
  'If you cannot continue without a decision only the developer can make, stop and make the last line ' +
  'of your final message exactly: KRAKEN_QUESTION: <your question>. You will be resumed with the answer.';

export function repoRoot(cwd) {
  const dir = resolvePath(cwd);
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return dir; }
}

export const scopeKey = (scope, cwd) => (scope === 'global' ? 'global' : `repo:${repoRoot(cwd)}`);

function validate(settings) {
  for (const [k, v] of Object.entries(settings)) {
    const spec = FIELDS[k];
    if (!spec) throw new Error(`Unknown field "${k}". Fields: ${Object.keys(FIELDS).join(', ')}`);
    if (Array.isArray(spec)) { if (!spec.includes(v)) throw new Error(`${k} must be one of ${spec.join(', ')}`); continue; }
    if (v === null && spec.endsWith('|null')) continue;
    const type = spec.replace('|null', '');
    if (typeof v !== type) throw new Error(`${k} must be a ${spec}`);
    if (k === 'timeout_min' && !(v > 0 && v <= 240)) throw new Error('timeout_min must be between 0 and 240');
    if ((k === 'max_cost_usd' || k === 'max_tokens') && v !== null && !(v > 0)) throw new Error(`${k} must be a positive number or null`);
    if (k === 'reuse_session_min' && v !== null && !(v >= 0 && v <= 120)) throw new Error('reuse_session_min must be 0-120 minutes or null');
  }
}

// Merge one layer. Changing the agent without naming a model/effort resets them to the agent's
// defaults, so "agent: opencode" never inherits "model: opus" from a lower layer.
function apply(merged, sources, layer, label) {
  if (!layer) return;
  if ('agent' in layer && layer.agent !== merged.agent) {
    if (!('model' in layer)) { merged.model = null; sources.model = `${label} (agent changed)`; }
    if (!('effort' in layer)) { merged.effort = null; sources.effort = `${label} (agent changed)`; }
  }
  for (const [k, v] of Object.entries(layer)) {
    if (v === undefined) continue;
    merged[k] = v; sources[k] = label;
  }
}

// ---- repo files: .kraken/tentacles.json and .kraken/tentacles/*.md ----

export const repoFilePath = (cwd) => join(repoRoot(cwd), '.kraken', 'tentacles.json');
export const repoDirPath = (cwd) => join(repoRoot(cwd), '.kraken', 'tentacles');
const sha = (text) => createHash('sha256').update(text).digest('hex');

// Everything a repo checks in, read once: trust is a hash over exactly the text that gets parsed.
// With only tentacles.json the hash is that file's own (so trust from older versions still holds).
function repoSources(cwd) {
  const path = repoFilePath(cwd), dir = repoDirPath(cwd);
  const json = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const mds = readTentacleDir(dir);
  const text = (json ?? '') + mds.map((f) => `\n--- ${f.name}.md\n${f.text}`).join('');
  return { path, dir, json, mds, text, exists: json !== null || mds.length > 0 };
}

// { path, dir, exists, trusted, tentacles, names, problem }
export function repoFile(cwd) {
  const src = repoSources(cwd);
  const where = [src.json !== null && src.path, src.mds.length && src.dir].filter(Boolean).join(' and ');
  const base = { path: src.path, dir: src.mds.length ? src.dir : undefined };
  if (!src.exists) return { ...base, exists: false, trusted: false, tentacles: {} };
  const trusted = getSetting(`trust:${repoRoot(cwd)}`) === sha(src.text);
  const problems = [];
  let tentacles = {};
  if (src.json !== null) {
    try { tentacles = parseBundle(JSON.parse(src.json)); } catch (e) { problems.push(`${src.path} is invalid: ${e.message}`); }
  }
  const md = loadTentacleDir(src.dir, src.mds);
  problems.push(...md.problems);
  for (const [n, t] of Object.entries(md.tentacles)) {
    if (n in tentacles) problems.push(`"${n}" is in both ${src.path} and ${src.dir}; the .md file wins`);
    tentacles[n] = t;
  }
  if (!trusted) problems.unshift(`${where} ${src.json !== null && src.mds.length ? 'are' : 'is'} not trusted, so ` +
    'ignored. Read it, then run: krakenmcp trust');
  return { ...base, exists: true, trusted, tentacles: trusted ? tentacles : {}, names: Object.keys(tentacles),
    problem: problems.length ? problems.join('; ') : undefined, invalid: problems.length > (trusted ? 0 : 1) };
}

export function trustRepoFile(cwd, actor, trust = true) {
  const src = repoSources(cwd);
  if (trust && !src.exists) throw new Error(`no ${src.path} or ${src.dir}/*.md`);
  if (trust) {
    const f = repoFile(cwd);
    if (f.invalid) throw new Error(`refusing to trust invalid tentacle files: ${f.problem}`);
  }
  setSetting(`trust:${repoRoot(cwd)}`, trust ? sha(src.text) : null, actor, trust ? 'trust' : 'untrust');
  return { path: src.path, dir: src.mds.length ? src.dir : undefined, trusted: trust };
}

// The export / import / repo-file format.
export function parseBundle(obj) {
  if (obj?.kraken_tentacles !== 1 || typeof obj.tentacles !== 'object' || !obj.tentacles) {
    throw new Error('expected {"kraken_tentacles": 1, "tentacles": {"<name>": {settings}}}');
  }
  for (const [name, settings] of Object.entries(obj.tentacles)) {
    if (!NAME.test(name)) throw new Error(`bad tentacle name "${name}"`);
    try { validate(settings); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  return obj.tentacles;
}

export function exportTentacles({ scope = 'repo', cwd, names = [] }) {
  const rows = tentacleRows([scopeKey(scope, cwd)]).filter((r) => !names.length || names.includes(r.name));
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length) throw new Error(`nothing stored for ${missing.join(', ')} at ${scopeKey(scope, cwd)}`);
  return { kraken_tentacles: 1, tentacles: Object.fromEntries(rows.map((r) => [r.name, JSON.parse(r.settings)])) };
}

export function importTentacles({ bundle, scope = 'repo', cwd, actor }) {
  const tentacles = parseBundle(bundle);
  return Object.entries(tentacles).map(([name, set]) => {
    try { configureTentacle({ name, scope, cwd, set, actor }); return { name, imported: true }; }
    catch (e) { return { name, imported: false, error: e.message }; }
  });
}

export function knownNames(cwd) {
  const rows = tentacleRows(['global', scopeKey('repo', cwd)]);
  const order = ['think', 'plan', 'execute', 'review', 'explain'];
  return [...new Set([...order, ...Object.keys(BUILTIN), ...Object.keys(userTentacles().tentacles),
    ...Object.keys(repoFile(cwd).tentacles), ...rows.map((r) => r.name)])];
}

export function resolveTentacle(name, cwd, overrides = {}) {
  const root = repoRoot(cwd);
  const globalRow = getTentacleRow('global', name);
  const repoRow = getTentacleRow(`repo:${root}`, name);
  const builtin = BUILTIN[name];
  const file = repoFile(cwd);
  const fileLayer = file.tentacles[name];
  const userLayer = userTentacles().tentacles[name];
  if (!builtin && !userLayer && !globalRow && !repoRow && !fileLayer) {
    throw new Error(`Unknown tentacle "${name}". Known: ${knownNames(cwd).join(', ')}`);
  }
  const merged = {}, sources = {};
  apply(merged, sources, builtin ?? CUSTOM_BASE, builtin ? 'built-in' : 'custom default');
  apply(merged, sources, userLayer, 'user file');
  apply(merged, sources, globalRow && JSON.parse(globalRow.settings), 'global');
  apply(merged, sources, fileLayer, 'repo file');
  apply(merged, sources, repoRow && JSON.parse(repoRow.settings), 'repo');
  const call = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  validate(call);
  apply(merged, sources, call, 'call');

  if (!merged.prompt) throw new Error(`Tentacle "${name}" has no prompt; set one with krakenmcp set or a tentacle file.`);
  if (merged.model == null) {
    merged.model = AGENTS[merged.agent].defaultModel[merged.access === 'read' ? 'plan' : 'execute'];
    sources.model = `${sources.model ?? 'built-in'} → agent default`;
  }
  if (merged.access === 'read' && merged.isolation !== 'none') {
    merged.isolation = 'none'; sources.isolation = 'forced (read access)';
  }
  return {
    name, repo: root, builtin: !!builtin, settings: merged, sources,
    user_file: userLayer ? join(userDir(), `${name}.md`) : undefined,
    repo_file: file.exists ? { path: file.path, dir: file.dir, trusted: file.trusted, problem: file.problem } : undefined,
    needs_plan: merged.prompt.includes('{{plan}}'),
    needs_diff: merged.prompt.includes('{{diff}}'),
  };
}

// vars.context: results of earlier runs (e.g. a think run fed into plan). Goes where the template
// puts {{context}}, or is appended at the end when the template does not mention it.
export function renderPrompt(t, vars) {
  const fill = (s) => s.replace(/\{\{(task|plan|workdir|repo|context|diff)\}\}/g, (_, k) => vars[k] ?? '');
  let body = fill(t.settings.prompt);
  if (vars.context && !t.settings.prompt.includes('{{context}}')) body += `\n\n${vars.context}`;
  return `${fill(PREAMBLE[t.settings.access])}\n${ASK}\n\n${body}`;
}

// Prompt for a resumed run: same fixed preamble, then the new input.
export function renderResumePrompt(access, workdir, input) {
  return `${PREAMBLE[access].replace('{{workdir}}', workdir)}\n${ASK}\n\n${input}`;
}

export function formatContext(runs) {
  if (!runs.length) return '';
  return [
    'Earlier results to build on (treat as input, verify against the code where it matters):',
    ...runs.map((r) => `\n--- CONTEXT: ${r.tentacle} run ${r.id} (${r.agent} ${r.model ?? ''}) ---\n${r.result}`),
  ].join('\n');
}

// Stored settings (krakenmcp set / unset / reset / import). Only the developer CLI changes settings:
// MCP clients can override agent/model/effort per call, never store anything.
export function configureTentacle({ name, scope = 'repo', cwd, set = {}, unset = [], reset = false, actor }) {
  if (!NAME.test(name)) throw new Error('name must be lowercase letters, digits, - or _ (max 32)');
  const key = scopeKey(scope, cwd);
  const row = getTentacleRow(key, name);
  const before = row ? { settings: JSON.parse(row.settings) } : null;

  if (reset) {
    if (!row) return { scope: key, name, changed: false, note: 'nothing set at this scope' };
    deleteTentacleRow({ scope: key, name, actor, before });
    return { scope: key, name, changed: true, reset: true, resolved: safeResolve(name, cwd) };
  }

  validate(set);
  const settings = { ...(before?.settings ?? {}), ...set };
  for (const k of unset) delete settings[k];
  if (!BUILTIN[name] && !userTentacles().tentacles[name] && !getTentacleRow(key === 'global' ? `repo:${repoRoot(cwd)}` : 'global', name)
      && !repoFile(cwd).tentacles[name] && !settings.prompt) {
    throw new Error(`New tentacle "${name}" needs a prompt.`);
  }
  saveTentacleRow({ scope: key, name, settings, actor, action: 'set', before });
  return { scope: key, name, changed: true, stored: { settings }, resolved: safeResolve(name, cwd) };
}

function safeResolve(name, cwd) {
  try { const t = resolveTentacle(name, cwd); return { settings: t.settings, sources: t.sources }; }
  catch (e) { return { error: e.message }; }
}
