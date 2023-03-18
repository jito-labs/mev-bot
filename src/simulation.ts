import { PublicKey, RpcResponseAndContext } from '@solana/web3.js';
import { randomUUID } from 'crypto';
import EventEmitter from 'events';
import { logger } from './logger.js';
import { connection } from './connection.js';
import { SimulatedBundleResponse } from 'jito-ts';
import { FilteredTransaction } from './preSimulationFilter.js';

type SimulationResult = {
  response: RpcResponseAndContext<SimulatedBundleResponse>;
  accountsOfInterest: PublicKey[];
};

const pendingSimulations = new Map<
  string,
  Promise<{
    uuid: string;
    response: RpcResponseAndContext<SimulatedBundleResponse> | null;
    accountsOfInterest: PublicKey[];
    startTime: number;
  }>
>();

async function startSimulations(
  txnIterator: AsyncGenerator<FilteredTransaction>,
  eventEmitter: EventEmitter,
) {
  for await (const { txn, accountsOfInterest } of txnIterator) {
    const addresses = accountsOfInterest.map((key) => key.toBase58());
    const sim = connection.simulateBundle([txn], {
      preExecutionAccountsConfigs: [{ addresses, encoding: 'base64' }],
      postExecutionAccountsConfigs: [{ addresses, encoding: 'base64' }],
      simulationBank: 'tip',
    });
    const uuid = randomUUID(); // use hash instead of uuid?
    //logger.info(`Simulating txn ${uuid}`);
    const startTime = Date.now();
    pendingSimulations.set(
      uuid,
      sim
        .then((res) => {
          return {
            uuid: uuid,
            response: res,
            accountsOfInterest,
            startTime: startTime,
          };
        })
        .catch((e) => {
          logger.error(e);
          return {
            uuid: uuid,
            response: null,
            accountsOfInterest,
            startTime: startTime,
          };
        }),
    );
    eventEmitter.emit('addPendingSimulation', uuid);
  }
}

async function* simulate(
  txnIterator: AsyncGenerator<FilteredTransaction>,
): AsyncGenerator<SimulationResult> {
  const eventEmitter = new EventEmitter();
  startSimulations(txnIterator, eventEmitter);

  while (true) {
    if (pendingSimulations.size === 0) {
      await new Promise((resolve) =>
        eventEmitter.once('addPendingSimulation', resolve),
      );
    }

    const { uuid, response, accountsOfInterest, startTime } =
      await Promise.race(pendingSimulations.values());
    logger.debug(`Simulation ${uuid} took ${Date.now() - startTime}ms`);
    if (response !== null) {
      yield { response, accountsOfInterest };
    }
    pendingSimulations.delete(uuid);
  }
}

export { simulate, SimulationResult };
