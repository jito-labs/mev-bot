import {
  RpcResponseAndContext,
  SimulatedTransactionResponse,
  VersionedTransaction,
} from '@solana/web3.js';
import { randomUUID } from 'crypto';
import EventEmitter from 'events';
import { logger } from './logger.js';
import { connection } from './connection.js';

const pendingSimulations = new Map<
  string,
  Promise<{
    uuid: string;
    response: RpcResponseAndContext<SimulatedTransactionResponse> | null;
    startTime: number;
  }>
>();

async function startSimulations(
  txnsIterator: AsyncGenerator<VersionedTransaction[]>,
  eventEmitter: EventEmitter,
) {
  for await (const txns of txnsIterator) {
    for (const txn of txns) {
      const sim = connection.simulateTransaction(txn);
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
              startTime: startTime,
            };
          })
          .catch((e) => {
            logger.error(e);
            return { uuid: uuid, response: null, startTime: startTime };
          }),
      );
      eventEmitter.emit('addPendingSimulation', uuid);
    }
  }
}

async function* simulate(
  txnsIterator: AsyncGenerator<VersionedTransaction[]>,
): AsyncGenerator<RpcResponseAndContext<SimulatedTransactionResponse>> {
  const eventEmitter = new EventEmitter();
  startSimulations(txnsIterator, eventEmitter);

  while (true) {
    if (pendingSimulations.size === 0) {
      await new Promise((resolve) =>
        eventEmitter.once('addPendingSimulation', resolve),
      );
    }

    const { uuid, response, startTime } = await Promise.race(
      pendingSimulations.values(),
    );
    logger.debug(`Simulation ${uuid} took ${Date.now() - startTime}ms`);
    if (response !== null) {
      yield response;
    }
    pendingSimulations.delete(uuid);
  }
}

export { simulate };
