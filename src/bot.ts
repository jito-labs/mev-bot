import { logger } from './logger.js';
import { mempool } from './mempool.js';
import { simulate } from './simulation.js';
import { postSimulateFilter } from './postSimulationFilter.js';
import { preSimulationFilter } from './preSimulationFilter.js';
import { calculateArb } from './calculateArb.js';


const mempoolUpdates = mempool();
const filteredTransactions = preSimulationFilter(mempoolUpdates);
const simulations = simulate(filteredTransactions);
const backrunnableTrades = postSimulateFilter(simulations);
const arbIdeas = calculateArb(backrunnableTrades);

for await (const arbIdea of arbIdeas) {
  logger.info(
    `chain timings: pre sim: ${
      arbIdea.timings.preSimEnd - arbIdea.timings.mempoolEnd
    }ms, sim: ${
      arbIdea.timings.simEnd - arbIdea.timings.preSimEnd
    }ms, post sim: ${
      arbIdea.timings.postSimEnd - arbIdea.timings.simEnd
    }ms, arb calc: ${
      arbIdea.timings.calcArbEnd - arbIdea.timings.postSimEnd
    }ms ::: total ${arbIdea.timings.calcArbEnd - arbIdea.timings.mempoolEnd}ms`,
  );
}
