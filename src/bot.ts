import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import * as fs from 'fs';

import { config } from './config.js';
import { logger } from './logger.js';

const BLOCK_ENGINE_URL = config.get('block_engine_url');
const AUTH_KEYPAIR_PATH = config.get('auth_keypair_path');
const RPC_URL = config.get('rpc_url');

const PROGRAMS_OF_INTEREST = [
  new PublicKey('JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB'),
];

const decodedKey = new Uint8Array(
  JSON.parse(fs.readFileSync(AUTH_KEYPAIR_PATH).toString()) as number[],
);
const keypair = Keypair.fromSecretKey(decodedKey);

const client = searcherClient(BLOCK_ENGINE_URL, keypair);
logger.info(BLOCK_ENGINE_URL);

const connection = new Connection(RPC_URL);

async function* simulate(transactionsIterator: AsyncIterable<VersionedTransaction[]>) {
  for await (const transactions of transactionsIterator) {
    logger.info(transactions.length.toString());
    for (const transaction of transactions) {
      yield connection.simulateTransaction(transaction);
    }
  }
}

const programUpdates = client.programUpdates(PROGRAMS_OF_INTEREST, (error) => logger.error(error));
const simulations = simulate(programUpdates);


for await (const sim of simulations) {
  logger.info(sim.context.slot.toString());
  logger.info(sim.value.logs.toString());
}

