import {
  Connection,
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
  Promise<[string, RpcResponseAndContext<SimulatedTransactionResponse>, number]>
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
        sim.then((res) => [uuid, res, startTime]),
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
    try {
      const [key, result, startTime] = await Promise.race(
        pendingSimulations.values(),
      );
      logger.debug(`Simulation ${key} took ${Date.now() - startTime}ms`);
      yield result;
      pendingSimulations.delete(key);
    } catch (e) {
      logger.error(e);
    }
  }
}

export { simulate };
