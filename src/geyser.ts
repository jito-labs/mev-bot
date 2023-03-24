import { AccountInfo, PublicKey } from '@solana/web3.js';
import { geyserClient as jitoGeyserClient, GeyserClient as JitoGeyserClient } from 'jito-ts';
import {
  AccountUpdate,
  TimestampedAccountUpdate,
} from 'jito-ts/dist/gen/geyser/geyser.js';
import { config } from './config.js';
import { logger } from './logger.js';

const GEYSER_URL = config.get('geyser_url');
const GEYSER_ACCESS_TOKEN = config.get('geyser_access_token');

const client = jitoGeyserClient(GEYSER_URL, GEYSER_ACCESS_TOKEN);

type AccountUpdateCallback = (data: AccountInfo<Buffer>) => void;
type AccountSubscriptionHandlersMap = Map<string, AccountUpdateCallback>;

class GeyserClient {
  jitoClient: JitoGeyserClient;
  seqs: Map<string, number>;
  updateCallbacks: AccountSubscriptionHandlersMap;
  closeCurrentSubscription: () => void;

  constructor() {
    this.jitoClient = client;
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

    const callback = this.updateCallbacks.get(address.toBase58());
    const accountInfo: AccountInfo<Buffer> = {
      data: Buffer.from(accountUpdate.data),
      executable: accountUpdate.isExecutable,
      lamports: accountUpdate.lamports,
      owner: new PublicKey(accountUpdate.owner),
    };
    callback(accountInfo);
  }

  private subscribe() {
    const accounts = Array.from(this.updateCallbacks.keys()).map(
      (key) => new PublicKey(key),
    );
    this.closeCurrentSubscription();
    this.closeCurrentSubscription = this.jitoClient.onAccountUpdate(
      accounts,
      this.processUpdate.bind(this),
      (error) => logger.error(error),
    );
  }

  addSubscriptions(subscriptions: AccountSubscriptionHandlersMap) {
    subscriptions.forEach((callback, address) => {
      this.updateCallbacks.set(address, callback);
      this.seqs.set(address, 0);
    });
    this.subscribe();
  }
}

const geyserClient = new GeyserClient();

export { geyserClient, AccountSubscriptionHandlersMap };
