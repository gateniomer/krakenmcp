// Tentacles: named actions (plan, execute, or custom) with layered settings.
// Tentacles are .md files: built-ins in src/tentacles/, the developer's own in ~/.kraken/tentacles/.
// Resolution order, last wins: built-in -> user file -> chain stage -> call arguments
// (agent/model/effort/verify/stage_verify only; a call can never set autonomy).
// Only the developer changes settings, by editing files; MCP clients can override per call.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents.js';
import { DATA_DIR } from './store.js';
import { repoRoot } from './git.js';
import { fail } from './util.js';

export const FIELDS = {
  description: 'string',
  access: ['read', 'write'],
  agent: Object.keys(AGENTS),
  model: 'string|null',      // null = the agent's default model
  effort: 'string|null',
  prompt: 'string',          // template: {{task}} {{plan}} {{context}} {{diff}} {{workdir}} {{repo}}
  verify: 'string|null',     // shell command Kraken runs after a write tentacle (once, at the end)
  stage_verify: 'string|null', // cheaper command run after each stage of a staged run
  verify_timeout_min: 'number', // limit for each verify / stage_verify / setup command
  setup: 'string|null',      // shell command run once in a new worktree before the agent (e.g. npm ci)
  stages: ['auto', 'off'],   // auto: a plan with 2+ "Stage" headings runs one fresh agent session per stage
  timeout_min: 'number',
  max_cost_usd: 'number|null', // stop the run when its cost passes this (agents that report cost)
  max_tokens: 'number|null',   // stop the run when input + output + reasoning tokens pass this
  // The step after a successful run: ask = the head suggests it and waits for the developer;
  // auto = the head (or a chain) may take it without asking. Hard stops always stop.
  autonomy: ['ask', 'auto'],
};

// Defaults for every tentacle file; a custom tentacle must set at least `prompt`.
const CUSTOM_BASE = {
  description: '', access: 'read', agent: 'opencode', model: null, effort: null,
  verify: null, stage_verify: null, verify_timeout_min: 10, setup: null, stages: 'auto',
  timeout_min: 30, max_cost_usd: null, max_tokens: null, autonomy: 'ask',
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
export const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const headerValue = (v) => { try { return JSON.parse(v); } catch { return v; } };

// The "---" header (typed values) and the body after it; shared by tentacle and chain files.
export function parseHeader(text, what = 'the prompt') {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) fail(`expected a "---" settings header, a closing "---", then ${what}`);
  const settings = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 1) fail(`bad header line "${line}" (expected key: value)`);
    settings[line.slice(0, i).trim()] = headerValue(line.slice(i + 1).trim());
  }
  return { settings, body: (m[2] ?? '').trim() };
}

export function parseTentacleFile(text) {
  const { settings, body: prompt } = parseHeader(text);
  if ('prompt' in settings) fail('the prompt goes after the header, not in it');
  if (prompt) settings.prompt = prompt;
  validate(settings);
  return settings;
}

// Every <name>.md in dir: { tentacles: {name: settings}, problems: [..], files: [paths] }.
// A broken file is skipped and reported; it never hides the other tentacles.
// Shared with chain files: every <name>.md in dir parsed with `parse` into { items, problems, files }.
export function loadFileDir(dir, parse) {
  const out = { items: {}, problems: [], files: [] };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const path = join(dir, f), name = f.slice(0, -3);
    out.files.push(path);
    if (!NAME.test(name)) {
      out.problems.push(`${path}: file name must be lowercase letters, digits, - or _ (max 32)`);
      continue;
    }
    try { out.items[name] = parse(readFileSync(path, 'utf8')); } catch (e) {
      out.problems.push(`${path}: ${e.message}`);
    }
  }
  return out;
}
export function loadTentacleDir(dir) {
  const { items, problems, files } = loadFileDir(dir, parseTentacleFile);
  return { tentacles: items, problems, files };
}

// Built-ins ship as files next to this module; edit them there.
export const BUILTIN_DIR = fileURLToPath(new URL('./tentacles/', import.meta.url));
export const BUILTIN = Object.fromEntries(Object.entries(loadTentacleDir(BUILTIN_DIR).tentacles)
  .map(([n, t]) => [n, { ...CUSTOM_BASE, ...t }]));
// The developer's own tentacle files (trusted: they live in the developer's data dir).
export const userDir = () => join(DATA_DIR, 'tentacles');
export const userTentacles = () => loadTentacleDir(userDir());

// Starter text for `krakenmcp edit <name>`. For a built-in: every field commented out with its
// current value, and no prompt (so the built-in prompt keeps getting Kraken's updates).
// For a new tentacle: the required fields and a sample prompt.
export function tentacleTemplate(name) {
  const builtin = BUILTIN[name];
  const fields = (s, skip = []) => Object.keys(FIELDS).filter((k) => k !== 'prompt' && !skip.includes(k))
    .map((k) => `# ${k}: ${s[k] ?? null}`);
  if (builtin) {
    return ['---',
      `# Change only what you need: uncomment a line and edit its value. Built-in values for ${name}:`,
      ...fields(builtin), '# To replace the built-in prompt, write your own below the closing ---.',
      '---', ''].join('\n');
  }
  return ['---', `description: What ${name} does, in one line`, 'access: read', `agent: ${CUSTOM_BASE.agent}`,
    '# Optional (defaults shown):', ...fields(CUSTOM_BASE, ['description', 'access', 'agent']), '---',
    `You are the ${name.toUpperCase()}. Describe the job and what your final message must contain.`, '',
    'TASK: {{task}}', ''].join('\n');
}

// Fixed preamble per access level. Prompts can change what a tentacle does, not what it may do.
const PREAMBLE = {
  read: 'You have READ-ONLY access. Do not create, edit or delete any files.',
  write: 'Your working directory is {{workdir}}. All paths are relative to it. ' +
    'Never read or edit files outside this directory, ' +
    'even if the instructions mention another absolute path.',
};
// Same for every tentacle: how an agent asks the developer instead of guessing (status 'waiting').
const ASK = 'You are a Kraken sub-agent: do this task yourself. ' +
  'Do not call Kraken tools or delegate to other agents. ' +
  'If you cannot continue without a decision only the developer can make, stop and make the last line ' +
  'of your final message exactly: KRAKEN_QUESTION: <your question>. You will be resumed with the answer.';

export function validate(settings) {
  for (const [k, v] of Object.entries(settings)) {
    const spec = FIELDS[k];
    if (!spec) fail(`Unknown field "${k}". Fields: ${Object.keys(FIELDS).join(', ')}`);
    if (Array.isArray(spec)) {
      if (!spec.includes(v)) fail(`${k} must be one of ${spec.join(', ')}`);
      continue;
    }
    if (v === null && spec.endsWith('|null')) continue;
    const type = spec.replace('|null', '');
    if (typeof v !== type) fail(`${k} must be a ${spec}`);
    if (k === 'timeout_min' && !(v > 0 && v <= 240)) fail('timeout_min must be between 0 and 240');
    if (k === 'verify_timeout_min' && !(v > 0 && v <= 120)) {
      fail('verify_timeout_min must be between 0 and 120');
    }
    const isLimit = k === 'max_cost_usd' || k === 'max_tokens';
    if (isLimit && v !== null && !(v > 0)) fail(`${k} must be a positive number or null`);
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

export function knownNames(cwd) {
  const order = ['think', 'plan', 'execute', 'review', 'explain', 'research'];
  return [...new Set([...order, ...Object.keys(BUILTIN), ...Object.keys(userTentacles().tentacles)])];
}

// layers: extra { label, values } applied after the user file and before the call (chain stages).
export function resolveTentacle(name, cwd, overrides = {}, layers = []) {
  const root = repoRoot(cwd);
  const builtin = BUILTIN[name];
  const userLayer = userTentacles().tentacles[name];
  if (!builtin && !userLayer) {
    fail(`Unknown tentacle "${name}". Known: ${knownNames(cwd).join(', ')}`);
  }
  const merged = {}, sources = {};
  apply(merged, sources, builtin ?? CUSTOM_BASE, builtin ? 'built-in' : 'custom default');
  apply(merged, sources, userLayer, 'user file');
  for (const { label, values } of layers) {
    const layer = Object.fromEntries(Object.entries(values ?? {}).filter(([, v]) => v !== undefined));
    validate(layer);
    apply(merged, sources, layer, label);
  }
  // autonomy is the developer's: a call cannot set it.
  const call = Object.fromEntries(Object.entries(overrides)
    .filter(([k, v]) => v !== undefined && k !== 'autonomy'));
  validate(call);
  apply(merged, sources, call, 'call');

  if (!merged.prompt) fail(`Tentacle "${name}" has no prompt; add one in ${join(userDir(), `${name}.md`)}.`);
  if (merged.model == null) {
    merged.model = AGENTS[merged.agent].defaultModel[merged.access];
    sources.model = `${sources.model ?? 'built-in'} → agent default`;
  }
  return {
    name, repo: root, builtin: !!builtin, settings: merged, sources, autonomy: merged.autonomy,
    user_file: userLayer ? join(userDir(), `${name}.md`) : undefined,
    needs_plan: merged.prompt.includes('{{plan}}'),
    needs_diff: merged.prompt.includes('{{diff}}'),
  };
}

// What a tentacle does in a chain: review (reads a diff), write (works on a branch), or read.
export const stageKind = (t) => (t.needs_diff ? 'review' : t.settings.access === 'write' ? 'write' : 'read');

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
    ...runs.map((r) => `\n--- CONTEXT: ${r.tentacle} run ${r.id} (${r.agent} ${r.model ?? ''}) ---\n` +
      r.result),
  ].join('\n');
}
