// Detached process that drives one chain (see chain.js) until it finishes or pauses for the developer.
import { tick } from './chain.js';
import { updateChain, nowIso } from './store.js';

const id = process.argv[2];
const loop = () => {
  let more;
  try { more = tick(id); } catch (e) {
    updateChain(id, { status: 'failed', stage: 'finished', error: e.message, finished_at: nowIso() });
    more = false;
  }
  if (more) setTimeout(loop, 1000); else process.exit(0);
};
updateChain(id, { pid: process.pid });
loop();
