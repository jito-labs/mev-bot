import { mempool } from './mempool.js';
import { simulate } from './simulation.js';
import { postSimulateFilter } from './post-simulation-filter.js';
import { preSimulationFilter } from './pre-simulation-filter.js';
import { calculateArb } from './calculate-arb.js';
import { buildBundle } from './build-bundle.js';
import { sendBundle } from './send-bundle.js';

const mempoolUpdates = mempool();
const filteredTransactions = preSimulationFilter(mempoolUpdates);
const simulations = simulate(filteredTransactions);
const backrunnableTrades = postSimulateFilter(simulations);
const arbIdeas = calculateArb(backrunnableTrades);
const bundles = buildBundle(arbIdeas);
await sendBundle(bundles);
