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

const STAGE_KEYS = ['tentacle', 'agent', 'model', 'effort', 'verify', 'autonomy'];
const CHAIN_KEYS = ['description', 'stages', 'max_fix_rounds'];
export const MAX_STAGES = 8;
export const DEFAULT_FIX_ROUNDS = 1;

export function parseChainFile(text) {
  const { settings, body } = parseHeader(text, 'optional notes');
  for (const k of Object.keys(settings)) {
    if (!CHAIN_KEYS.includes(k)) throw new Error(`Unknown field "${k}". Fields: ${CHAIN_KEYS.join(', ')}`);
  }
  if ('description' in settings && typeof settings.description !== 'string') throw new Error('description must be a string');
  if ('max_fix_rounds' in settings) {
    const n = settings.max_fix_rounds;
    if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error('max_fix_rounds must be an integer from 0 to 5');
  }
  if ('stages' in settings) checkStages(settings.stages);
  return { ...settings, notes: body || undefined };
}

function checkStages(stages) {
  if (!Array.isArray(stages)) throw new Error('stages must be a JSON array, e.g. [{"tentacle": "plan"}]');
  if (!stages.length || stages.length > MAX_STAGES) throw new Error(`stages must have 1 to ${MAX_STAGES} entries`);
  stages.forEach((s, i) => {
    const at = `stage ${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at} must be an object like {"tentacle": "plan"}`);
    for (const k of Object.keys(s)) {
      if (!STAGE_KEYS.includes(k)) throw new Error(`${at}: unknown key "${k}". Keys: ${STAGE_KEYS.join(', ')}`);
    }
    if (typeof s.tentacle !== 'string' || !NAME.test(s.tentacle)) throw new Error(`${at}: tentacle must be a tentacle name`);
    const { tentacle, ...rest } = s;
    try { validate(rest); } catch (e) { throw new Error(`${at}: ${e.message}`); }
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
  if (!builtin && !user) throw new Error(`Unknown chain "${name}"; known: ${knownChains().join(', ')}`);
  const merged = { max_fix_rounds: DEFAULT_FIX_ROUNDS, description: '' }, sources = {};
  for (const [layer, label] of [[builtin, 'built-in'], [user, 'user file']]) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (k === 'notes' || v === undefined) continue;
      merged[k] = v; sources[k] = label;
    }
  }
  if (!merged.stages) throw new Error(`chain "${name}" has no stages; add them in ${join(userChainDir(), `${name}.md`)}`);
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
  if (writes.length > 1) problems.push(`a chain can have only one write stage (found ${writes.map((s) => s.tentacle).join(', ')})`);
  const w = writes[0];
  for (const s of stages) {
    if (s.kind === 'write' && s.needs_plan && !stages.some((x) => x.index < s.index && x.kind === 'read')) {
      problems.push(`stage ${s.index + 1} (${s.tentacle}) needs a plan: put a read stage (e.g. plan) before it`);
    }
    if (s.kind === 'review' && !(w && w.index < s.index)) {
      problems.push(`stage ${s.index + 1} (${s.tentacle}) reviews a branch: it must come after the write stage`);
    }
    if (s.kind !== 'write' && 'verify' in s.layer) problems.push(`stage ${s.index + 1} (${s.tentacle}): verify is only for the write stage`);
  }
  return { stages, has_write: !!w, problems };
}

// Starter text for `krakenmcp chain edit <name>`.
export function chainTemplate(name) {
  const b = BUILTIN_CHAINS[name];
  if (b) {
    return ['---', `# Change only what you need: uncomment a line and edit its value. Built-in values for ${name}:`,
      `# description: ${b.description ?? ''}`, `# stages: ${JSON.stringify(b.stages)}`,
      `# max_fix_rounds: ${b.max_fix_rounds ?? DEFAULT_FIX_ROUNDS}`,
      '# A stage may also set agent, model, effort, verify (write stage only) and autonomy (ask|auto).', '---', ''].join('\n');
  }
  return ['---', `description: What the ${name} chain does, in one line`,
    'stages: [{"tentacle": "plan"}, {"tentacle": "execute"}, {"tentacle": "review"}]',
    `max_fix_rounds: ${DEFAULT_FIX_ROUNDS}`, '---',
    'Notes for you (never sent to agents). Each stage follows its tentacle\'s autonomy unless it sets its own:',
    'ask pauses the chain after that stage, auto goes on. Stage keys: tentacle, agent, model, effort,',
    `verify, autonomy (${FIELDS.autonomy.join('|')}). Fix rounds never pause; max_fix_rounds: 0 turns them off.`, ''].join('\n');
}
