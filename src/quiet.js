// Drop Node's "SQLite is an experimental feature" warning: MCP clients show stderr as noise.
// Must be imported before anything that loads node:sqlite. Other warnings pass through.
export function isSqliteExperimental(warning, typeOrOptions) {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type ?? warning?.name;
  return type === 'ExperimentalWarning' && /sqlite/i.test(msg);
}

const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (isSqliteExperimental(warning, rest[0])) return;
  return emit.call(process, warning, ...rest);
};
