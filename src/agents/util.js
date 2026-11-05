// Shared parsing helpers for agent adapters.
export const jsonLines = (stdout) =>
  stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

export const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 });

export function countTools(names, failedCount = 0) {
  const by_tool = {};
  for (const n of names) by_tool[n] = (by_tool[n] || 0) + 1;
  return { total: names.length, failed: failedCount, by_tool };
}
