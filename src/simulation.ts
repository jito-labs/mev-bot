import {
  Connection,
  RpcResponseAndContext,
  SimulatedTransactionResponse,
  VersionedTransaction,
} from '@solana/web3.js';
import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import { config } from './config.js';
import { logger } from './logger.js';

const RPC_URL = config.get('rpc_url');

// in case wanna add batching do this https://github.com/solana-labs/solana/issues/23627#issuecomment-1147770729
const connection = new Connection(RPC_URL);

const pendingSimulations = new Map<
  string,
  Promise<[string, RpcResponseAndContext<SimulatedTransactionResponse>]>
>();

async function startSimulations(
  txnsIterator: AsyncGenerator<VersionedTransaction[]>,
  eventEmitter: EventEmitter,
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

async function* simulate(txnsIterator: AsyncGenerator<VersionedTransaction[]>) {
  const eventEmitter = new EventEmitter();
  startSimulations(txnsIterator, eventEmitter);

  while (true) {
    if (pendingSimulations.size === 0 ) {
        await new Promise((resolve) => eventEmitter.once('addPendingSimulation', resolve));
    }
    const [key, result] = await Promise.race(pendingSimulations.values());
    yield result;
    pendingSimulations.delete(key);
  }
}

export { simulate };
