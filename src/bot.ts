import { logger } from './logger.js';
import { getProgramUpdates } from './mempool.js';
import { simulate } from './simulation.js';
import { connection } from './connection.js';
import { postSimulateFilter } from './postSimulationFilter.js';
import { config } from './config.js';

// Garbage collector set up, needed otherwise memory fills up
const GC_INTERVAL_SEC = config.get('gc_interval_sec');
setInterval(() => { global.gc(); }, 1000 * GC_INTERVAL_SEC);

const programUpdates = getProgramUpdates();
const simulations = simulate(programUpdates, connection);
const potentialArbIdeas = postSimulateFilter(simulations);

for await (const arbIdea of potentialArbIdeas) {
  logger.trace(arbIdea);
}
