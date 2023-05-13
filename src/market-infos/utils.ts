import { AccountInfo, PublicKey } from '@solana/web3.js';
import { connection } from '../clients/rpc.js';
import { AccountSubscriptionHandlersMap } from '../clients/geyser.js';
import { logger } from '../logger.js';
import { AccountInfoMap, SerializableAccountInfo } from './types.js';

/**
 * Helper to init a set of accounts and if any of those changes callback with the whole set
 */
class GeyserMultipleAccountsUpdateHandler {
  isInitialized: boolean;
  resolveOnInitialized: Promise<void>;
  accountInfoMap: AccountInfoMap;
  callback: (accountInfos: AccountInfoMap) => void;
  addresses: PublicKey[];

  constructor(
    addresses: PublicKey[],
    callback: (accountInfos: AccountInfoMap) => void,
  ) {
    this.accountInfoMap = new Map();
    this.isInitialized = false;
    this.callback = callback;
    this.addresses = addresses;

    let resolve: () => void;
    this.resolveOnInitialized = new Promise((r) => {
      resolve = r;
    });

    connection.getMultipleAccountsInfo(addresses).then((accountInfos) => {
      for (let i = 0; i < accountInfos.length; i++) {
        this.accountInfoMap.set(addresses[i].toBase58(), accountInfos[i]);
      }
      this.isInitialized = true;
      resolve();
      callback(this.accountInfoMap);
    });
  }

  getUpdateHandlers(): AccountSubscriptionHandlersMap {
    const geyserSubscriptions: AccountSubscriptionHandlersMap = new Map();

    for (const address of this.addresses) {
      const handler = (accountInfo: AccountInfo<Buffer> | null) => {
        this.accountInfoMap.set(address.toBase58(), accountInfo);
        if (this.isInitialized) {
          logger.trace(`Geyser AMM account update: ${address.toBase58()}`);
          try {
            this.callback(this.accountInfoMap);
          } catch (e) {
            logger.error(
              e,
              `Geyser AMM update failed for ${address.toBase58()}`,
            );
          }
        }
      };
      if (geyserSubscriptions.has(address.toBase58())) {
        geyserSubscriptions.get(address.toBase58()).push(handler);
      } else {
        geyserSubscriptions.set(address.toBase58(), [handler]);
      }
    }

    return geyserSubscriptions;
  }

  async waitForInitialized() {
    await this.resolveOnInitialized;
  }
}

function toPairString(mintA: PublicKey, mintB: PublicKey): string {
  if (mintA.toBase58() < mintB.toBase58()) {
    return `${mintA.toBase58()}-${mintB.toBase58()}`;
  } else {
    return `${mintB.toBase58()}-${mintA.toBase58()}`;
  }
}

function toSerializableAccountInfo(accountInfo: AccountInfo<Buffer>) {
  return {
    data: new Uint8Array(accountInfo.data),
    executable: accountInfo.executable,
    lamports: accountInfo.lamports,
    owner: accountInfo.owner.toBase58(),
    rentEpoch: accountInfo.rentEpoch,
  };
}

function toAccountInfo(accountInfo: SerializableAccountInfo) {
  return {
    data: Buffer.from(accountInfo.data),
    executable: accountInfo.executable,
    lamports: accountInfo.lamports,
    owner: new PublicKey(accountInfo.owner),
    rentEpoch: accountInfo.rentEpoch,
  };
}

export {
  GeyserMultipleAccountsUpdateHandler,
  toPairString,
  toSerializableAccountInfo,
  toAccountInfo,
};
