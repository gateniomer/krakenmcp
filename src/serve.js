// Entry for `krakenmcp` with no arguments: the full server, or a tool-less one when nested.
import { nestedRun } from './nesting.js';

const parent = nestedRun();
if (parent) (await import('./disabled-server.js')).startDisabled(parent);
else await import('./server.js');
