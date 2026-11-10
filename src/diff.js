// Review diffs: keeping a large diff within the reviewer's prompt budget. Pure.

export const MAX_DIFF = 80_000;
// A diff over MAX_DIFF goes in whole files, smallest first, until the budget is used; the files left
// out are listed with the command that shows them, so the reviewer reads them itself instead of
// getting a diff cut off in the middle of a file.
export function capDiff(d, base = 'HEAD', max = MAX_DIFF) {
  if (d.length <= max) return d;
  const files = d.split(/^(?=diff --git )/m).filter(Boolean);
  const pathOf = (f) => f.match(/^diff --git a\/(.+?) b\//)?.[1] ?? '?';
  const order = files.map((f, i) => ({ f, i })).sort((a, b) => a.f.length - b.f.length);
  const keep = new Set();
  let used = 0;
  for (const { f, i } of order) if (used + f.length <= max) { keep.add(i); used += f.length; }
  const left = files.filter((_, i) => !keep.has(i));
  const listed = left.map((f) => `  ${pathOf(f)} (${f.length} chars): git diff ${base} -- ${pathOf(f)}`);
  const shown = files.filter((_, i) => keep.has(i)).join('');
  return `${shown}\n…[${left.length} of ${files.length} changed files are not shown (diff is ` +
    `${d.length} chars, limit ${max}). Read each with the command shown:]\n${listed.join('\n')}`;
}
