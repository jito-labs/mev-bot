import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { logger } from './logger.js';
import { Timings } from './types.js';
import { searcherClient } from './jitoClient.js';

const PROGRAMS_OF_INTEREST = [
  new PublicKey('JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB'), // Jupiter
  new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), // Raydium
  new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'), // Orca Whirlpools
];

type MempoolUpdate = {
  txns: VersionedTransaction[];
  timings: Timings;
};

const getProgramUpdates = () =>
  searcherClient.programUpdates(PROGRAMS_OF_INTEREST, (error) => {
    logger.error(error);
    throw error;
  }
  );

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
        buildBundleEnd: 0,
        bundleSent: 0,
      },
    };
  }
}

export { mempool, MempoolUpdate };
