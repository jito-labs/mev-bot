import {
  PublicKey,
  RpcResponseAndContext,
  VersionedTransaction,
} from '@solana/web3.js';
import EventEmitter from 'events';
import { logger } from './logger.js';
import { connection } from './connection.js';
import { SimulatedBundleResponse } from 'jito-ts';
import { FilteredTransaction } from './preSimulationFilter.js';
import { Timings } from './types.js';

// drop slow sims - usually a sign of high load
const MAX_SIMULATION_AGE_MS = 200;

const MAX_PENDING_SIMULATIONS = 300;

type SimulationResult = {
  txn: VersionedTransaction;
  response: RpcResponseAndContext<SimulatedBundleResponse>;
  accountsOfInterest: PublicKey[];
  timings: Timings;
};

let pendingSimulations = 0;

const resolvedSimulations: {
  txn: VersionedTransaction;
  response: RpcResponseAndContext<SimulatedBundleResponse> | null;
  accountsOfInterest: PublicKey[];
  timings: Timings;
}[] = [];

async function startSimulations(
  txnIterator: AsyncGenerator<FilteredTransaction>,
  eventEmitter: EventEmitter,
) {
  for await (const { txn, accountsOfInterest, timings } of txnIterator) {
    if (pendingSimulations > MAX_PENDING_SIMULATIONS) {
      logger.warn(
        'dropping txn due to high pending simulation count: ' +
          pendingSimulations,
      );
      continue;
    }

    const addresses = accountsOfInterest.map((key) => key.toBase58());
    const sim = connection.simulateBundle([txn], {
      preExecutionAccountsConfigs: [{ addresses, encoding: 'base64' }],
      postExecutionAccountsConfigs: [{ addresses, encoding: 'base64' }],
      simulationBank: 'tip',
    });
    pendingSimulations += 1;
    sim
      .then((res) => {
        resolvedSimulations.push({
          txn,
          response: res,
          accountsOfInterest,
          timings,
        });
        pendingSimulations -= 1;
        eventEmitter.emit('resolvedSimulation');
      })
      .catch((e) => {
        logger.error(e);
        resolvedSimulations.push({
          txn,
          response: null,
          accountsOfInterest,
          timings,
        });
        pendingSimulations -= 1;
        eventEmitter.emit('resolvedSimulation');
      });
  }
}

async function* simulate(
  txnIterator: AsyncGenerator<FilteredTransaction>,
): AsyncGenerator<SimulationResult> {
  const eventEmitter = new EventEmitter();
  startSimulations(txnIterator, eventEmitter);

  while (true) {
    if (resolvedSimulations.length === 0) {
      await new Promise((resolve) =>
        eventEmitter.once('resolvedSimulation', resolve),
      );
    }

    const { txn, response, accountsOfInterest, timings } =
      resolvedSimulations.shift();
    logger.debug(`Simulation took ${Date.now() - timings.preSimEnd}ms`);
    const txnAge = Date.now() - timings.mempoolEnd;

    if (txnAge > MAX_SIMULATION_AGE_MS) {
      logger.warn(`dropping slow simulation - age: ${txnAge}ms`);
      continue;
    }

    if (response !== null) {
      yield {
        txn,
        response,
        accountsOfInterest,
        timings: {
          mempoolEnd: timings.mempoolEnd,
          preSimEnd: timings.preSimEnd,
          simEnd: Date.now(),
          postSimEnd: 0,
          calcArbEnd: 0,
          buildBundleEnd: 0,
          bundleSent: 0,
        },
      };
    }
  }
}

export { simulate, SimulationResult };
