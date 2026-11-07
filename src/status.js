// The status tool: wait while a run or chain is busy (sending progress notifications), then reply
// with its card, summary and feed (compact while it runs, full once it ends).
import { IN_PROGRESS, getRun, getChain } from './store.js';
import { pump } from './scheduler.js';
import { isChainId } from './chain.js';
import { describeChain, chainStatus, chainFeed, chainSummary, chainCard } from './chain-view.js';
import { describe } from './view.js';
import { runFeed, runSummary, runCard } from './feed.js';
import { fail } from './util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A run or a chain behind one interface, so status treats both the same way.
function subject(id) {
  if (isChainId(id)) {
    return { kind: 'chain', load: () => getChain(id), busy: (c) => chainStatus(c) === 'running',
      summary: chainSummary, card: chainCard, feed: chainFeed, describe: describeChain };
  }
  return { kind: 'run', load: () => getRun(id), busy: (r) => IN_PROGRESS.includes(r.status),
    summary: runSummary, card: runCard, feed: runFeed,
    describe: (r, full, live) => ({ ...describe(r, full), ...live }) };
}

// Poll once a second until it is no longer busy or the wait is over. A progress notification goes
// out when the headline changes (ignoring the clock) and about every 10 seconds otherwise.
async function waitWhileBusy(s, item, seconds, progress) {
  const started = Date.now(), deadline = started + seconds * 1000;
  let lastKey = null;
  while (s.busy(item) && Date.now() < deadline) {
    await sleep(1000);
    item = s.load();
    if (!progress) continue;
    const live = s.summary(item);
    const elapsed = Date.now() - started;
    if (live.key !== lastKey || elapsed % 10_000 < 1000) {
      lastKey = live.key;
      progress(Math.round(elapsed / 1000), live.headline);
    }
  }
  return item;
}

export async function status({ run_id, wait_seconds = 0, full = false, since }, progress) {
  pump(); // also recovers runs whose worker died, and starts queued runs if there is room
  const s = subject(run_id);
  let item = s.load();
  if (!item) fail(`no ${s.kind} ${run_id}`);
  item = await waitWhileBusy(s, item, wait_seconds, progress);
  const summary = s.summary(item);
  const card = s.card(item, summary);
  if (since === undefined) return { card, ...s.describe(item, full), summary };
  const busy = s.busy(item);
  const live = s.feed(item, since, !busy);
  if (!busy) return { card, ...s.describe(item, full, live), summary };
  // Compact while it runs: only what the head shows to the developer.
  return { card, id: item.id, status: summary.status, stage: summary.stage, elapsed_s: summary.elapsed_s,
    cost_usd: summary.cost_usd, summary, feed: live.feed, cursor: live.cursor,
    next: 'show card as-is in a code block with the feed lines under it (even if there are none), ' +
      `then call status again with since: ${live.cursor}` };
}
