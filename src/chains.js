// Chains: an ordered list of tentacle stages, run by chain.js. Chains are .md files like tentacles:
// built-ins in src/chains/, the developer's own in ~/.kraken/chains/. The body is notes for the
// developer and is never sent to an agent.
//
//   ---
//   description: Plan, implement and review
//   stages: [{"tentacle": "plan"}, {"tentacle": "execute", "autonomy": "auto"}, {"tentacle": "review"}]
//   max_fix_rounds: 1
//   ---
//
// Each stage may set agent, model, effort, verify and autonomy for that stage only (layer
// "chain <name>"). A successful stage continues to the next when its autonomy is auto, and pauses
// for the developer when it is ask. Fix rounds (review changes_requested, failed verify) never pause.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './store.js';
import { FIELDS, NAME, parseHeader, validate, resolveTentacle, stageKind, loadFileDir } from './tentacles.js';
import { fail } from './util.js';

const STAGE_KEYS = ['tentacle', 'agent', 'model', 'effort', 'verify', 'autonomy'];
const CHAIN_KEYS = ['description', 'stages', 'max_fix_rounds'];
export const MAX_STAGES = 8;
export const DEFAULT_FIX_ROUNDS = 1;

export function parseChainFile(text) {
  const { settings, body } = parseHeader(text, 'optional notes');
  for (const k of Object.keys(settings)) {
    if (!CHAIN_KEYS.includes(k)) fail(`Unknown field "${k}". Fields: ${CHAIN_KEYS.join(', ')}`);
  }
  const { description } = settings;
  if (description !== undefined && typeof description !== 'string') fail('description must be a string');
  if ('max_fix_rounds' in settings) {
    const n = settings.max_fix_rounds;
    if (!Number.isInteger(n) || n < 0 || n > 5) fail('max_fix_rounds must be an integer from 0 to 5');
  }
  if ('stages' in settings) checkStages(settings.stages);
  return { ...settings, notes: body || undefined };
}

function checkStages(stages) {
  if (!Array.isArray(stages)) fail('stages must be a JSON array, e.g. [{"tentacle": "plan"}]');
  if (!stages.length || stages.length > MAX_STAGES) fail(`stages must have 1 to ${MAX_STAGES} entries`);
  stages.forEach((s, i) => {
    const at = `stage ${i + 1}`;
    const isObject = s && typeof s === 'object' && !Array.isArray(s);
    if (!isObject) fail(`${at} must be an object like {"tentacle": "plan"}`);
    for (const k of Object.keys(s)) {
      if (!STAGE_KEYS.includes(k)) fail(`${at}: unknown key "${k}". Keys: ${STAGE_KEYS.join(', ')}`);
    }
    const named = typeof s.tentacle === 'string' && NAME.test(s.tentacle);
    if (!named) fail(`${at}: tentacle must be a tentacle name`);
    const { tentacle, ...rest } = s;
    try { validate(rest); } catch (e) { fail(`${at}: ${e.message}`); }
  });
}

function loadChainDir(dir) {
  const { items, problems, files } = loadFileDir(dir, parseChainFile);
  return { chains: items, problems, files };
}

export const BUILTIN_CHAIN_DIR = fileURLToPath(new URL('./chains/', import.meta.url));
export const BUILTIN_CHAINS = loadChainDir(BUILTIN_CHAIN_DIR).chains;
export const userChainDir = () => join(DATA_DIR, 'chains');
export const userChains = () => loadChainDir(userChainDir());

export function knownChains() {
  const rest = [...new Set([...Object.keys(BUILTIN_CHAINS), ...Object.keys(userChains().chains)])]
    .filter((n) => n !== 'default').sort();
  return ['default', ...rest];
}

// The built-in is the base and the user file overrides it field by field (stages as a whole).
export function resolveChain(name = 'default') {
  const builtin = BUILTIN_CHAINS[name];
  const user = userChains().chains[name];
  if (!builtin && !user) fail(`Unknown chain "${name}"; known: ${knownChains().join(', ')}`);
  const merged = { max_fix_rounds: DEFAULT_FIX_ROUNDS, description: '' }, sources = {};
  for (const [layer, label] of [[builtin, 'built-in'], [user, 'user file']]) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (k === 'notes' || v === undefined) continue;
      merged[k] = v; sources[k] = label;
    }
  }
  const file = join(userChainDir(), `${name}.md`);
  if (!merged.stages) fail(`chain "${name}" has no stages; add them in ${file}`);
  return { name, builtin: !!builtin, description: merged.description, stages: merged.stages,
    max_fix_rounds: merged.max_fix_rounds, notes: user?.notes ?? builtin?.notes, sources,
    user_file: user ? join(userChainDir(), `${name}.md`) : undefined };
}

// Resolve every stage's tentacle in this repo and check that the stages make a runnable chain.
// The result is the snapshot a chain run keeps, so later file edits never change a running chain.
export function checkChain(chain, cwd) {
  const problems = [], stages = [];
  const label = `chain ${chain.name}`;
  chain.stages.forEach((s, index) => {
    const { tentacle, ...layer } = s;
    let t;
    try { t = resolveTentacle(tentacle, cwd, {}, [{ label, values: layer }]); }
    catch (e) { problems.push(`stage ${index + 1} (${tentacle}): ${e.message}`); return; }
    stages.push({ index, tentacle, kind: stageKind(t), access: t.settings.access, needs_plan: t.needs_plan,
      autonomy: t.autonomy, autonomy_source: t.sources.autonomy, layer });
  });
  const writes = stages.filter((s) => s.kind === 'write');
  if (writes.length > 1) {
    const names = writes.map((s) => s.tentacle).join(', ');
    problems.push(`a chain can have only one write stage (found ${names})`);
  }
  const w = writes[0];
  const at = (s) => `stage ${s.index + 1} (${s.tentacle})`;
  for (const s of stages) {
    if (s.kind === 'write' && s.needs_plan && !stages.some((x) => x.index < s.index && x.kind === 'read')) {
      problems.push(`${at(s)} needs a plan: put a read stage (e.g. plan) before it`);
    }
    if (s.kind === 'review' && !(w && w.index < s.index)) {
      problems.push(`${at(s)} reviews a branch: it must come after the write stage`);
    }
    const verifyOnRead = s.kind !== 'write' && 'verify' in s.layer;
    if (verifyOnRead) problems.push(`${at(s)}: verify is only for the write stage`);
  }
  return { stages, has_write: !!w, problems };
}

// Starter text for `krakenmcp chain edit <name>`.
export function chainTemplate(name) {
  const b = BUILTIN_CHAINS[name];
  if (b) {
    return ['---',
      `# Change only what you need: uncomment a line and edit its value. Built-in values for ${name}:`,
      `# description: ${b.description ?? ''}`, `# stages: ${JSON.stringify(b.stages)}`,
      `# max_fix_rounds: ${b.max_fix_rounds ?? DEFAULT_FIX_ROUNDS}`,
      '# A stage may also set agent, model, effort, verify (write stage only) and autonomy (ask|auto).',
      '---', ''].join('\n');
  }
  return ['---', `description: What the ${name} chain does, in one line`,
    'stages: [{"tentacle": "plan"}, {"tentacle": "execute"}, {"tentacle": "review"}]',
    `max_fix_rounds: ${DEFAULT_FIX_ROUNDS}`, '---',
    'Notes for you (never sent to agents). Each stage follows its tentacle\'s autonomy unless it sets',
    'its own: ask pauses the chain after that stage, auto goes on. Stage keys: tentacle, agent, model,',
    `effort, verify, autonomy (${FIELDS.autonomy.join('|')}). Fix rounds never pause; max_fix_rounds: 0`,
    'turns them off.', ''].join('\n');
}
