import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { logger } from './logger.js';
import { Timings } from './types.js';
import { SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import { fuseGenerators } from './utils.js';
import { searcherClients } from './clients/jito.js';

const PROGRAMS_OF_INTEREST = [
  new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), // Raydium
  new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'), // Orca Whirlpools
  new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'), // Raydium CLMM
  new PublicKey('9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP'), // Orca V2
  new PublicKey('DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1'), // Orca
];

type MempoolUpdate = {
  txns: VersionedTransaction[];
  timings: Timings;
};

const getProgramUpdates = (searcherClient: SearcherClient) =>
  searcherClient.programUpdates(PROGRAMS_OF_INTEREST, (error) => {
    logger.error(error);
    throw error;
  });

async function* mempool(): AsyncGenerator<MempoolUpdate> {
  const generators: AsyncGenerator<VersionedTransaction[]>[] = [];

  for (const searcherClient of searcherClients) {
    generators.push(getProgramUpdates(searcherClient));
  }

  // subscribing to multiple mempools is in particular useful in europe (frankfurt and amsterdam)
  const updates = fuseGenerators(generators);

  for await (const update of updates) {
    yield {
      txns: update,
      timings: {
        mempoolEnd: Date.now(),
        preSimEnd: 0,
        simEnd: 0,
        postSimEnd: 0,
        calcArbEnd: 0,
        buildBundleEnd: 0,
        bundleSent: 0,
      },
    };
  }
}

export { mempool, MempoolUpdate };
