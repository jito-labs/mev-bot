import { logger } from './logger.js';
import { getProgramUpdates } from './mempool.js';
import { simulate } from './simulation.js';
import { postSimulateFilter } from './postSimulationFilter.js';
import { config } from './config.js';
import { preSimulationFilter } from './preSimulationFilter.js';

// Garbage collector set up, needed otherwise memory fills up
const GC_INTERVAL_SEC = config.get('gc_interval_sec');
setInterval(() => {
  global.gc();
}, 1000 * GC_INTERVAL_SEC);

const programUpdates = getProgramUpdates();
const filteredTransactions = preSimulationFilter(programUpdates);
const simulations = simulate(filteredTransactions);
const potentialArbIdeas = postSimulateFilter(simulations);

for await (const arbIdea of potentialArbIdeas) {
  logger.trace(arbIdea);
}
