import { logger } from './logger.js';
import { mempool } from './mempool.js';
import { simulate } from './simulation.js';
import { postSimulateFilter } from './postSimulationFilter.js';
import { config } from './config.js';
import { preSimulationFilter } from './preSimulationFilter.js';
import { calculateArb } from './calculateArb.js';
import { dropBeyondHighWaterMark } from './common.js';

// Garbage collector set up, needed otherwise memory fills up
const GC_INTERVAL_SEC = config.get('gc_interval_sec');
setInterval(() => {
  global.gc();
}, 1000 * GC_INTERVAL_SEC);

const HIGH_WATER_MARK = 100;

const mempoolUpdates = dropBeyondHighWaterMark(mempool(), HIGH_WATER_MARK);
const filteredTransactions = dropBeyondHighWaterMark(
  preSimulationFilter(mempoolUpdates),
  HIGH_WATER_MARK,
);
const simulations = dropBeyondHighWaterMark(
  simulate(filteredTransactions),
  HIGH_WATER_MARK,
);
const backrunnableTrades = dropBeyondHighWaterMark(
  postSimulateFilter(simulations),
  HIGH_WATER_MARK,
);
const arbIdeas = dropBeyondHighWaterMark(
  calculateArb(backrunnableTrades),
  HIGH_WATER_MARK,
);

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
