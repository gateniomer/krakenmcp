// Plan text: reading a plan from a file in the repository (optionally one section of it) and
// splitting a plan into stages. Pure apart from the file read, so it is unit-tested on its own.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { isInside, fail } from './util.js';

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
// "## Stage 2: title", "### Stage 2b - title", "## Stage two". Only "Stage" headings count, so a
// plan's other headings (Goal, Risks, ...) never split it.
const STAGE = /^stage\b/i;

// Markdown headings outside fenced code blocks: [{ line, level, text }].
export function headings(lines) {
  const out = [];
  let fence = null;
  lines.forEach((l, line) => {
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (fence) return;
    const m = l.match(HEADING);
    if (m) out.push({ line, level: m[1].length, text: m[2] });
  });
  return out;
}

// The lines of heading h up to the next heading of the same or a higher level.
function sectionEnd(hs, i, total) {
  const next = hs.slice(i + 1).find((x) => x.level <= hs[i].level);
  return next ? next.line : total;
}

// One section of a Markdown text: the first heading whose text contains `name` (case-insensitive),
// up to the next heading of the same or a higher level. Returns { section, rest } or null.
export function pickSection(text, name) {
  const lines = text.split('\n');
  const hs = headings(lines);
  const want = name.trim().toLowerCase();
  const i = hs.findIndex((h) => h.text.toLowerCase().includes(want));
  if (i < 0) return null;
  const start = hs[i].line, end = sectionEnd(hs, i, lines.length);
  return {
    title: hs[i].text,
    section: lines.slice(start, end).join('\n').trim(),
    rest: [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim(),
  };
}

// Stages of a plan: every "Stage ..." heading at the level of the first one. Fewer than two means the
// plan is not staged. Returns [{ title, body }].
export function splitStages(text) {
  const lines = (text ?? '').split('\n');
  const all = headings(lines).filter((h) => STAGE.test(h.text));
  if (!all.length) return [];
  const level = all[0].level;
  const hs = headings(lines);
  const stages = hs.map((h, i) => ({ h, i })).filter(({ h }) => h.level === level && STAGE.test(h.text))
    .map(({ h, i }) => ({ title: h.text,
      body: lines.slice(h.line, sectionEnd(hs, i, lines.length)).join('\n').trim() }));
  return stages.length >= 2 ? stages : [];
}

// Read a plan from a file inside the repository. With `section`, only that section is the plan to
// implement; the rest of the file follows as context the agent must not implement.
// Returns { plan, staged_text, label }: staged_text is what stages are split from.
export function readPlanFile(root, cwd, file, section) {
  const path = resolve(cwd, file);
  if (!isInside(root, path)) fail(`plan_file must be inside the repository (${root}): ${file}`);
  if (!existsSync(path)) fail(`plan_file not found: ${file}`);
  const text = readFileSync(path, 'utf8');
  const rel = relative(root, path);
  if (!section) return { plan: text.trim(), staged_text: text, label: rel };
  const picked = pickSection(text, section);
  if (!picked) {
    const names = headings(text.split('\n')).map((h) => h.text).slice(0, 20).join(' | ');
    fail(`no heading containing "${section}" in ${rel}. Headings: ${names}`);
  }
  const plan = `${picked.section}\n\n--- REST OF ${rel} (context only: do NOT implement it) ---\n` +
    picked.rest;
  return { plan, staged_text: picked.section, label: `${rel} § ${picked.title}` };
}
