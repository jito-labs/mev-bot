import { logger } from './logger.js';
import { getProgramUpdates } from './mempool.js';
import { simulate } from './simulation.js';
import { connection } from './connection.js';

const programUpdates = getProgramUpdates();
const simulations = simulate(programUpdates, connection);

for await (const sim of simulations) {
  logger.info(sim.context.slot.toString());
  logger.info(sim.value.logs.toString());
}
