import { logger } from './logger.js';
import { getProgramUpdates } from './mempool.js';
import { simulate } from './simulation.js';
import { connection } from './connection.js';
import { postSimulateFilter } from './postSimulationFilter.js';

const programUpdates = getProgramUpdates();
const simulations = simulate(programUpdates, connection);
const potentialArbIdeas = postSimulateFilter(simulations);

for await (const arbIdea of potentialArbIdeas) {
  logger.trace(arbIdea);
}
