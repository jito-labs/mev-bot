import { logger } from './logger.js';
import { mempool } from './mempool.js';
import { simulate } from './simulation.js';
import { postSimulateFilter } from './postSimulationFilter.js';
import { preSimulationFilter } from './preSimulationFilter.js';
import { calculateArb } from './calculateArb.js';
import { buildBundle } from './buildBundle.js';


const mempoolUpdates = mempool();
const filteredTransactions = preSimulationFilter(mempoolUpdates);
const simulations = simulate(filteredTransactions);
const backrunnableTrades = postSimulateFilter(simulations);
const arbIdeas = calculateArb(backrunnableTrades);
const bundles = buildBundle(arbIdeas)

for await (const {timings} of bundles) {
  logger.info(
    `chain timings: pre sim: ${
      timings.preSimEnd - timings.mempoolEnd
    }ms, sim: ${
      timings.simEnd - timings.preSimEnd
    }ms, post sim: ${
      timings.postSimEnd - timings.simEnd
    }ms, arb calc: ${
      timings.calcArbEnd - timings.postSimEnd
    }ms build bundle: ${
      timings.buildBundleEnd - timings.calcArbEnd
    }ms ::: total ${timings.buildBundleEnd - timings.mempoolEnd}ms`,
  );
}
