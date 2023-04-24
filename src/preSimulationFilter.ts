import {
  AddressLookupTableAccount,
  MessageAccountKeys,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { dropBeyondHighWaterMark } from './backpressure.js';
import { logger } from './logger.js';
import { isTokenAccountOfInterest } from './market_infos/index.js';
import { MempoolUpdate } from './mempool.js';
import { Timings } from './types.js';
import { lookupTableProvider } from './lookupTableProvider.js';

const HIGH_WATER_MARK = 250;

type FilteredTransaction = {
  txn: VersionedTransaction;
  accountsOfInterest: PublicKey[];
  timings: Timings;
};

async function* preSimulationFilter(
  mempoolUpdates: AsyncGenerator<MempoolUpdate>,
): AsyncGenerator<FilteredTransaction> {
  const mempoolUpdatesGreedy = dropBeyondHighWaterMark(
    mempoolUpdates,
    HIGH_WATER_MARK,
    'mempoolUpdates',
  );

  for await (const { txns, timings } of mempoolUpdatesGreedy) {
    for (const txn of txns) {
      const addressLookupTableAccounts: AddressLookupTableAccount[] = [];

      for (const lookup of txn.message.addressTableLookups) {
        const lut = await lookupTableProvider.getLookupTable(lookup.accountKey);
        if (lut === null) {
          break;
        }
        addressLookupTableAccounts.push(
          lut
        );
      }

      let accountKeys: MessageAccountKeys | null = null;
      try {
        accountKeys = txn.message.getAccountKeys({
          addressLookupTableAccounts,
        });
      } catch (e) {
        logger.warn(e, 'address not in lookup table');
      }
      const accountsOfInterest = new Set<string>();
      for (const key of accountKeys.keySegments().flat()) {
        if (isTokenAccountOfInterest(key)) {
          accountsOfInterest.add(key.toBase58());
        }
      }

      if (accountsOfInterest.size === 0) continue;

      logger.debug(
        `Found txn with ${accountsOfInterest.size} accounts of interest`,
      );
      yield {
        txn,
        accountsOfInterest: [...accountsOfInterest].map(
          (key) => new PublicKey(key),
        ),
        timings: {
          mempoolEnd: timings.mempoolEnd,
          preSimEnd: Date.now(),
          simEnd: 0,
          postSimEnd: 0,
          calcArbEnd: 0,
          buildBundleEnd: 0,
          bundleSent: 0,
        },
      };
    }
  }
}

export { FilteredTransaction, preSimulationFilter };
