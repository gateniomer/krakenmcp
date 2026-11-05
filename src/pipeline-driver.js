// Detached process that drives one pipeline (see pipeline.js) until it finishes.
import { tick } from './pipeline.js';
import { updatePipeline, nowIso } from './store.js';

const id = process.argv[2];
const loop = () => {
  let more;
  try { more = tick(id); } catch (e) {
    updatePipeline(id, { status: 'failed', stage: 'finished', error: e.message, finished_at: nowIso() });
    more = false;
  }
  if (more) setTimeout(loop, 1000); else process.exit(0);
};
updatePipeline(id, { pid: process.pid });
loop();
