import {
  AddressLookupTableAccount,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { dropBeyondHighWaterMark } from './backpressure.js';
import { connection } from './connection.js';
import { logger } from './logger.js';
import { isTokenAccountOfInterest } from './market_infos/index.js';
import { MempoolUpdate } from './mempool.js';
import { Timings } from './types.js';

const HIGH_WATER_MARK = 100;

const adressLookupTableCache = new Map<string, AddressLookupTableAccount>();

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

      if (txn.message.addressTableLookups.length > 0) {
        logger.trace(
          `resolving txn with luts. current lut cache size: ${adressLookupTableCache.size}`,
        );
        for (const lookup of txn.message.addressTableLookups) {
          if (adressLookupTableCache.has(lookup.accountKey.toBase58())) {
            addressLookupTableAccounts.push(
              adressLookupTableCache.get(lookup.accountKey.toBase58()),
            );
            continue;
          }
          const lut = await connection.getAddressLookupTable(lookup.accountKey);
          if (lut.value === null) {
            break;
          }
          // todo: add ttl for cached luts
          adressLookupTableCache.set(lookup.accountKey.toBase58(), lut.value);
          addressLookupTableAccounts.push(lut.value);
        }
        // skip txns where luts can't be resolved
        if (
          addressLookupTableAccounts.length !==
          txn.message.addressTableLookups.length
        ) {
          logger.debug('Skipping txn due to unresolved luts');
          continue;
        }
      }

      const accountKeys = txn.message.getAccountKeys({
        addressLookupTableAccounts,
      });
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
        },
      };
    }
  }
}

export { FilteredTransaction, preSimulationFilter };
