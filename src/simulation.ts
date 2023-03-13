import {
  Connection,
  RpcResponseAndContext,
  SimulatedTransactionResponse,
  VersionedTransaction,
} from '@solana/web3.js';
import { randomUUID } from 'crypto';
import EventEmitter from 'events';
import { logger } from './logger.js';

const pendingSimulations = new Map<
  string,
  Promise<[string, RpcResponseAndContext<SimulatedTransactionResponse>]>
>();

async function startSimulations(
  txnsIterator: AsyncGenerator<VersionedTransaction[]>,
  eventEmitter: EventEmitter,
  connection: Connection,
) {
  for await (const txns of txnsIterator) {
    for (const txn of txns) {
      const sim = connection.simulateTransaction(txn);
      const uuid = randomUUID(); // use hash instead of uuid?
      logger.info(`Simulating txn ${uuid}`);
      pendingSimulations.set(
        uuid,
        sim.then((res) => [uuid, res]),
      );
      eventEmitter.emit('addPendingSimulation', uuid);
    }
  }
}

async function* simulate(
  txnsIterator: AsyncGenerator<VersionedTransaction[]>,
  connection: Connection,
): AsyncGenerator<RpcResponseAndContext<SimulatedTransactionResponse>> {
  const eventEmitter = new EventEmitter();
  startSimulations(txnsIterator, eventEmitter, connection);

  while (true) {
    if (pendingSimulations.size === 0) {
      await new Promise((resolve) =>
        eventEmitter.once('addPendingSimulation', resolve),
      );
    }
    const [key, result] = await Promise.race(pendingSimulations.values());
    yield result;
    pendingSimulations.delete(key);
  }
}

export { simulate };
