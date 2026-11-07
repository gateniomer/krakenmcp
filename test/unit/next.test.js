// Unit tests for finishedNext: the one step after a finished run, by kind, status and autonomy.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KRAKEN_DATA = join(mkdtempSync(join(tmpdir(), 'kraken-next-')), 'data');
let R;
before(async () => { R = await import('../../src/view.js'); });

const base = { id: 'r1', tentacle: 'x', kind: 'read', status: 'done', autonomy: 'ask' };
const cases = [
  [{ status: 'waiting' }, /^ask: put the question.*resume\("r1"/],
  [{ status: 'waiting', autonomy: 'auto' }, /^ask: put the question/],
  [{ status: 'failed', autonomy: 'auto' }, /^stop: report this error/],
  [{ status: 'timeout' }, /^stop: report this error/],
  [{ status: 'over_budget' }, /^stop: report this error/],
  [{ status: 'cancelled' }, /^stop: tell the developer it was cancelled/],
  [{ chain_id: 'chain_1' }, /stage of chain chain_1; follow status\("chain_1"\)/],
  [{ newer_run: 'r2' }, /^follow status\("r2"\)/],
  [{ outcome: 'merged', kind: 'write' }, /^stop: it was merged/],
  [{ status: 'verify_failed', kind: 'write', autonomy: 'auto' }, /^stop: show the verify output.*resume\("r1"/],
  [{ kind: 'write' }, /^ask:.*review\(run_id: "r1"\)/],
  [{ kind: 'write', autonomy: 'auto' }, /^auto:.*review\(run_id: "r1"\)/],
  [{ kind: 'review', target_run: 'e1', verdict: 'approve' }, /^ask:.*merge\("e1"\)/],
  [{ kind: 'review', target_run: 'e1', verdict: 'approve', autonomy: 'auto' }, /^auto: call merge\("e1"\)/],
  [{ kind: 'review', target_run: 'e1', verdict: 'changes_requested' }, /^ask:.*resume\("e1"/],
  [{ kind: 'review', target_run: 'e1', verdict: 'changes_requested', autonomy: 'auto' }, /^auto:.*resume\("e1"/],
  [{ kind: 'review', target_run: 'e1' }, /^ask: show the review; ask the developer/],
  [{ kind: 'review', autonomy: 'auto' }, /^ask:.*nothing to merge/],
  [{ tentacle: 'think' }, /^ask:.*open questions.*plan\(.*"r1"/],
  [{ tentacle: 'think', autonomy: 'auto' }, /^auto: if it has no open questions call plan\(/],
  [{ tentacle: 'plan' }, /^ask:.*execute\("r1"\)/],
  [{ tentacle: 'plan', autonomy: 'auto' }, /^auto:.*execute\("r1"\)/],
  [{ tentacle: 'explain' }, /^ask:.*result_file/],
];

test('finishedNext: every case gives the right prefix and call', () => {
  for (const [facts, want] of cases) {
    const got = R.finishedNext({ ...base, ...facts });
    assert.match(got, want, JSON.stringify(facts));
  }
});

test('finishedNext: an uncommitted review never suggests a merge; an answered run without a successor has none', () => {
  assert.doesNotMatch(R.finishedNext({ ...base, kind: 'review', verdict: 'approve' }), /merge\(/);
  assert.equal(R.finishedNext({ ...base, status: 'answered' }), undefined);
  assert.equal(R.finishedNext({ ...base, status: 'queued' }), undefined);
});
