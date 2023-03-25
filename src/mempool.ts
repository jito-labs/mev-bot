import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';

import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import * as fs from 'fs';
import { config } from './config.js';
import { logger } from './logger.js';
import { Timings } from './types.js';

const BLOCK_ENGINE_URL = config.get('block_engine_url');
const AUTH_KEYPAIR_PATH = config.get('auth_keypair_path');

const PROGRAMS_OF_INTEREST = [
  new PublicKey('JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB'), // Jupiter
  new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), // Raydium
  new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'), // Orca Whirlpools
];

type MempoolUpdate = {
  txns: VersionedTransaction[];
  timings: Timings;
};

const decodedKey = new Uint8Array(
  JSON.parse(fs.readFileSync(AUTH_KEYPAIR_PATH).toString()) as number[],
);
const keypair = Keypair.fromSecretKey(decodedKey);

const client = searcherClient(BLOCK_ENGINE_URL, keypair);

const getProgramUpdates = () =>
  client.programUpdates(PROGRAMS_OF_INTEREST, (error) => logger.error(error));

async function* mempool(): AsyncGenerator<MempoolUpdate> {
  const updates = getProgramUpdates();
  for await (const update of updates) {
    yield {
      txns: update,
      timings: {
        mempoolEnd: Date.now(),
        preSimEnd: 0,
        simEnd: 0,
        postSimEnd: 0,
        calcArbEnd: 0,
      },
    };
  }
}

export { mempool, MempoolUpdate };
