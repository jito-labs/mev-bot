import {
  AddressLookupTableAccount,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { connection } from './connection.js';
import { logger } from './logger.js';
import { isTokenAccountOfInterest } from './market_infos/index.js';

const adressLookupTableCache = new Map<string, AddressLookupTableAccount>();

type FilteredTransaction = {
  txn: VersionedTransaction;
  accountsOfInterest: PublicKey[];
};

async function* preSimulationFilter(
  txnsIterator: AsyncGenerator<VersionedTransaction[]>,
): AsyncGenerator<FilteredTransaction> {
  for await (const txns of txnsIterator) {
    for (const txn of txns) {
      const addressLookupTableAccounts: AddressLookupTableAccount[] = [];

      if (txn.message.addressTableLookups.length > 0) {
        logger.trace(`resolving txn with luts. current lut cache size: ${adressLookupTableCache.size}`);
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
      const accountsOfInterest = new Set<PublicKey>();
      for (const key of accountKeys.keySegments().flat()) {
        if (isTokenAccountOfInterest(key)) {
          accountsOfInterest.add(key);
        }
      }

      if (accountsOfInterest.size === 0) continue;

      logger.debug(`Found txn with ${accountsOfInterest.size} accounts of interest`);
      yield { txn, accountsOfInterest: [...accountsOfInterest] };
    }
  }
}

export { FilteredTransaction, preSimulationFilter };
