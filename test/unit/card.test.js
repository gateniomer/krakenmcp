// Unit: card drawing (widths, cutting, wrapping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { box, displayWidth, fit, tildify, CARD_WIDTH } from '../../src/card.js';

test('displayWidth counts emoji as two columns and joiners as none', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('🦑'), 2);
  assert.equal(displayWidth('✓ ● › →'), 7);
  assert.equal(displayWidth('é'), 1);
  assert.equal(displayWidth('漢字'), 4);
});

test('fit cuts to a width with an ellipsis, never splitting a wide character', () => {
  assert.equal(fit('hello', 10), 'hello');
  assert.equal(fit('hello world', 6), 'hello…');
  assert.equal(displayWidth(fit('🦑🦑🦑🦑', 5)), 5);
});

test('box: every line has the same width, long titles and values are cut, values wrap up to their limit', () => {
  const b = box('🦑 chain default › stage with a very long title that does not fit at all', '◐ paused', [
    ['run', 'x'], ['empty', ''], ['skipped', null],
    ['next', 'ask: '.padEnd(300, 'word '), 2],
  ]);
  const lines = b.split('\n');
  assert.ok(lines.every((l) => displayWidth(l) === CARD_WIDTH), b);
  assert.match(lines[0], /… ─ ◐ paused ─╮$/);
  assert.ok(!b.includes('empty') && !b.includes('skipped'), 'empty rows are left out');
  assert.equal(lines.filter((l) => l.includes('word')).length, 2, 'next wraps to two lines');
  assert.match(lines.at(-2), /…\s*│$/);
  const plain = box('t', '', [['a', 'b']], 20);
  assert.ok(plain.split('\n').every((l) => displayWidth(l) === 20), plain);
});

test('tildify shortens paths under the home directory', () => {
  assert.equal(tildify(`${homedir()}/.kraken/plans/x.md`), '~/.kraken/plans/x.md');
  assert.equal(tildify('/tmp/x'), '/tmp/x');
});
