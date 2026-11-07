// Small helpers shared across modules.
import { resolve, relative, isAbsolute } from 'node:path';

// JSON.parse that never throws: unreadable or empty text gives `fallback`.
export function parseJson(text, fallback = undefined) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// Stored timestamps are ISO strings; older rows used SQLite datetime('now'): "YYYY-MM-DD HH:MM:SS", UTC.
export const toDate = (s) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);

// Milliseconds from `start` to `end` (or to now when it has not ended); undefined without a start.
export const elapsedMs = (start, end) =>
  (start ? (end ? toDate(end) : new Date()) - toDate(start) : undefined);

// Read every page: fetch(after) returns up to `size` rows ordered by id.
export function pageAll(fetch, since = 0, size = 200) {
  const out = [];
  for (let after = since; ;) {
    const rows = fetch(after);
    out.push(...rows);
    if (rows.length < size) return out;
    after = rows.at(-1).id;
  }
}

// True when `path` is strictly inside `dir` (never dir itself, never via ".."): the check every
// delete makes before it removes anything.
export function isInside(dir, path) {
  const rel = relative(resolve(dir), resolve(path));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

// Throw an Error with this message; usable as an expression (`x ?? fail('…')`).
export const fail = (message) => { throw new Error(message); };
