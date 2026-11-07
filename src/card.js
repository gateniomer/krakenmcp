// Cards: small bordered boxes the head shows the developer as-is, when a tentacle is called, on every
// status poll, and when it finishes. Kraken draws them (deterministic, no model tokens spent on
// layout); the head only pastes them. Pure functions, unit-tested.
//
//   ╭─ 🦑 plan › claude opus ─────────────────────────── ✓ done ─╮
//   │ took    2m 36s · $0.78 · 5 tools                            │
//   │ result  ~/.kraken/plans/plan_mw6e5hjp7926.md                │
//   ╰─────────────────────────────────────────────────────────────╯
import { homedir } from 'node:os';

export const CARD_WIDTH = 64; // total columns, borders included

// Terminal columns of one code point: 0 for combining marks and joiners, 2 for emoji and East Asian
// wide characters, 1 otherwise. Close enough for what cards contain (no grapheme clusters).
function cpWidth(cp) {
  if (cp === 0x200d || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  if (cp >= 0x1f000 || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)) return 2;
  return 1;
}
export const displayWidth = (s) => [...s].reduce((n, ch) => n + cpWidth(ch.codePointAt(0)), 0);

// Cut s to at most `width` columns, ending in … when cut.
export function fit(s, width) {
  if (displayWidth(s) <= width) return s;
  let out = '', w = 0;
  for (const ch of s) {
    const cw = cpWidth(ch.codePointAt(0));
    if (w + cw > width - 1) break;
    out += ch; w += cw;
  }
  return `${out}…`;
}

// Split s into lines of at most `width` columns, at spaces where possible; the last one is cut with …
function wrap(s, width, maxLines) {
  const lines = [];
  let rest = s;
  while (rest && lines.length < maxLines - 1 && displayWidth(rest) > width) {
    let cut = fit(rest, width + 1).replace(/…$/, '');
    const space = cut.lastIndexOf(' ');
    if (space > width / 2) cut = cut.slice(0, space);
    lines.push(cut);
    rest = rest.slice(cut.length).trimStart();
  }
  if (rest) lines.push(fit(rest, width));
  return lines;
}

const pad = (s, width) => s + ' '.repeat(Math.max(0, width - displayWidth(s)));
export const tildify = (p) => (p && homedir() && p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// title: left of the top border; status: right of it; rows: [label, value, maxLines?] (empty values skipped).
export function box(title, status, rows, width = CARD_WIDTH) {
  const inner = width - 4; // "│ " + text + " │"
  const st = status ? ` ${status} ` : '';
  const room = width - 7 - displayWidth(st); // "╭─ " title " " fill status "─╮", at least one ─ of fill
  const t = fit(title, Math.max(4, room));
  const fill = width - 3 - displayWidth(t) - 1 - displayWidth(st) - 2;
  const top = `╭─ ${t} ${'─'.repeat(Math.max(1, fill))}${st}─╮`;
  const used = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  const lw = Math.max(0, ...used.map(([l]) => displayWidth(l)));
  const body = [];
  for (const [label, value, maxLines = 1] of used) {
    const vw = inner - (lw ? lw + 2 : 0);
    wrap(oneLine(value), vw, maxLines).forEach((line, i) => {
      const head = lw ? `${pad(i ? '' : label, lw)}  ` : '';
      body.push(`│ ${pad(head + line, inner)} │`);
    });
  }
  return [top, ...body, `╰${'─'.repeat(width - 2)}╯`].join('\n');
}
