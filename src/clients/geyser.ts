import { AccountInfo, PublicKey } from '@solana/web3.js';
import { GeyserClient as JitoGeyserClient } from 'jito-ts';
import {
  AccountUpdate,
  TimestampedAccountUpdate,
} from 'jito-ts/dist/gen/geyser/geyser.js';
import { logger } from '../logger.js';
import { geyserClient as jitoGeyserClient } from './jito.js';

type AccountUpdateCallback = (data: AccountInfo<Buffer>) => void;
type AccountSubscriptionHandlersMap = Map<string, AccountUpdateCallback[]>;

class GeyserAccountUpdateClient {
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
    const address = new PublicKey(accountUpdate.pubkey).toBase58();

    if (accountUpdate.isStartup) return;
    if (accountUpdate.seq <= this.seqs.get(address)) return;

    this.seqs.set(address, accountUpdate.seq);

    const callbacks = this.updateCallbacks.get(address);
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
    logger.debug(`Subscribing to ${accounts.length} accounts`);
    this.closeCurrentSubscription();
    this.closeCurrentSubscription = this.jitoClient.onAccountUpdate(
      accounts,
      this.processUpdate.bind(this),
      (error) => {
        logger.error(error);
        throw error;
      },
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

class GeyserProgramUpdateClient {
  jitoClient: JitoGeyserClient;
  seqs: Map<string, number>;
  handler: (address: PublicKey, data: AccountInfo<Buffer>) => void;

  constructor(
    programId: PublicKey,
    handler: (address: PublicKey, data: AccountInfo<Buffer>) => void,
  ) {
    this.jitoClient = jitoGeyserClient;
    this.seqs = new Map();
    this.handler = handler;

    logger.debug(`Subscribing to ${programId.toBase58()} program`);
    this.jitoClient.onProgramUpdate(
      [programId],
      this.processUpdate.bind(this),
      (error) => {
        logger.error(error);
        throw error;
      },
    );
  }

  private processUpdate(resp: TimestampedAccountUpdate) {
    if (!resp.accountUpdate) return;
    const accountUpdate: AccountUpdate = resp.accountUpdate;
    const address = new PublicKey(accountUpdate.pubkey);
    const addressStr = address.toBase58();

    if (accountUpdate.isStartup) return;
    if (
      this.seqs.has(addressStr) &&
      accountUpdate.seq <= this.seqs.get(addressStr)
    )
      return;

    this.seqs.set(addressStr, accountUpdate.seq);

    const accountInfo: AccountInfo<Buffer> = {
      data: Buffer.from(accountUpdate.data),
      executable: accountUpdate.isExecutable,
      lamports: accountUpdate.lamports,
      owner: new PublicKey(accountUpdate.owner),
    };
    this.handler(address, accountInfo);
  }
}

const geyserAccountUpdateClient = new GeyserAccountUpdateClient();

export {
  geyserAccountUpdateClient,
  AccountSubscriptionHandlersMap,
  GeyserProgramUpdateClient,
};
