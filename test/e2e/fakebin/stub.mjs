// Stub of `opencode run ... --format json` for Kraken's e2e tests (Node, so it runs on every OS).
// Behaviour is driven by env vars:
//   STUB_SLEEP=n      sleep n seconds before exiting           STUB_EXIT=n   exit with code n (writes stderr)
//   STUB_QUESTION=1   end with KRAKEN_QUESTION (unless resumed) STUB_FILE=f   file a write run creates/edits
//   STUB_COST=x       report cost x in a step_finish right away (before sleeping), for budget tests
//   STUB_VERDICT=v    review verdict (default approve)           STUB_RESOLVE=1 strip conflict markers in a write run
//   STUB_ARGS_LOG=f   append each invocation's KRAKEN_PARENT_RUN and argv (one line) to f
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('opencode stub 0.0.0'); process.exit(0); }
const env = process.env;
if (env.STUB_ARGS_LOG) appendFileSync(env.STUB_ARGS_LOG, `parent=${env.KRAKEN_PARENT_RUN ?? ''} ${args.join(' ').replace(/\n/g, ' ')}\n`);
const prompt = args.at(-1);
const resumed = args.includes('--session');
const write = args.includes('--auto');
const S = { sessionID: 'ses_stub1' };
const emit = (o) => process.stdout.write(`${JSON.stringify({ ...o, ...S })}\n`);

emit({ type: 'step_start', part: {} });
if (env.STUB_PROVIDER_ERROR) { // like opencode when the model provider is unreachable: error event on stdout, empty stderr
  emit({ type: 'error', error: { type: 'provider.transport', message: 'ECONNREFUSED: Unable to connect.' } });
  process.exit(1);
}
if (env.STUB_EXIT) { process.stderr.write('stub failure\n'); process.exit(Number(env.STUB_EXIT)); }
if (env.STUB_COST) emit({ type: 'step_finish', part: { cost: Number(env.STUB_COST), tokens: { input: 1000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } });
let unmerged = [];
try { unmerged = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch {}
if (write && env.STUB_RESOLVE && unmerged.length) {
  // Resolve merge conflicts: keep both sides, drop the markers.
  for (const f of unmerged) {
    writeFileSync(f, readFileSync(f, 'utf8').split('\n').filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join('\n'));
  }
  emit({ type: 'tool_use', part: { tool: 'edit', state: { status: 'completed' } } });
} else if (write && (!env.STUB_QUESTION || resumed)) {
  const n = readdirSync('.').filter((f) => !f.startsWith('.')).length;
  const f = env.STUB_FILE || `f${n}.js`;
  appendFileSync(f, `export const v = "${n}-${resumed ? 'yes' : 'no'}";\n`);
  emit({ type: 'tool_use', part: { tool: 'write', state: { status: 'completed' } } });
}
for (let i = 1; i <= Number(env.STUB_LINES || 0); i++) { // feed tests: tool events between text events
  emit({ type: 'tool_use', part: { tool: 'write', state: { status: 'completed' } } });
  emit({ type: 'tool_use', part: { tool: 'write', state: { status: 'completed' } } });
  emit({ type: 'text', part: { text: `line ${i}` } });
}
if (env.STUB_LONG) emit({ type: 'text', part: { text: `long ${'x'.repeat(250)}` } });
let text;
if (prompt.includes('REVIEWER')) text = `VERDICT: ${env.STUB_VERDICT || 'approve'}\nFindings: ${env.STUB_VERDICT === 'changes_requested' ? '[major] math.js:1 - x - y' : 'none'}`;
else if (env.STUB_QUESTION && !resumed) text = 'Need a decision.\nKRAKEN_QUESTION: Keep it in a separate file?';
else text = `Done (resumed=${resumed ? 'yes' : 'no'}).`;
emit({ type: 'text', part: { text } });
emit({ type: 'step_finish', part: { cost: 0.001, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 50, write: 0 } } } });
setTimeout(() => process.exit(0), Number(env.STUB_SLEEP || 0) * 1000);
