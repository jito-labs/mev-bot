import { AccountInfo, PublicKey } from '@solana/web3.js';
import { GeyserClient as JitoGeyserClient } from 'jito-ts';
import {
  AccountUpdate,
  TimestampedAccountUpdate,
} from 'jito-ts/dist/gen/geyser/geyser.js';
import { logger } from './logger.js';
import { geyserClient as jitoGeyserClient } from './jitoClient.js';

type AccountUpdateCallback = (data: AccountInfo<Buffer>) => void;
type AccountSubscriptionHandlersMap = Map<string, AccountUpdateCallback[]>;

class GeyserClient {
  jitoClient: JitoGeyserClient;
  seqs: Map<string, number>;
  updateCallbacks: AccountSubscriptionHandlersMap;
  closeCurrentSubscription: () => void;

  constructor() {
    this.jitoClient = jitoGeyserClient;
    this.seqs = new Map();
    this.updateCallbacks = new Map();
    this.closeCurrentSubscription = () => {
      return;
    };
  }

  private processUpdate(resp: TimestampedAccountUpdate) {
    if (!resp.accountUpdate) return;
    const accountUpdate: AccountUpdate = resp.accountUpdate;
    const address = new PublicKey(accountUpdate.pubkey);

    if (accountUpdate.isStartup) return;
    if (accountUpdate.seq <= this.seqs.get(address.toBase58())) return;

    this.seqs.set(address.toBase58(), accountUpdate.seq);

    const callbacks = this.updateCallbacks.get(address.toBase58());
    const accountInfo: AccountInfo<Buffer> = {
      data: Buffer.from(accountUpdate.data),
      executable: accountUpdate.isExecutable,
      lamports: accountUpdate.lamports,
      owner: new PublicKey(accountUpdate.owner),
    };
    callbacks.forEach((callback) => callback(accountInfo));
  }

  private subscribe() {
    const accounts = Array.from(this.updateCallbacks.keys()).map(
      (key) => new PublicKey(key),
    );
    this.closeCurrentSubscription();
    this.closeCurrentSubscription = this.jitoClient.onAccountUpdate(
      accounts,
      this.processUpdate.bind(this),
      (error) => {
        logger.error(error);
        throw error;
      }
    );
  }

  addSubscriptions(subscriptions: AccountSubscriptionHandlersMap) {
    subscriptions.forEach((callbacks, address) => {
      if (this.updateCallbacks.has(address)) {
        this.updateCallbacks.get(address).push(...callbacks);
      } else {
        this.updateCallbacks.set(address, callbacks);
      }
      this.seqs.set(address, 0);
    });
    this.subscribe();
  }
}

const geyserClient = new GeyserClient();

export { geyserClient, AccountSubscriptionHandlersMap };
