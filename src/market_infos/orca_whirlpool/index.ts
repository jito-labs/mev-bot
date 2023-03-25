import * as whirpools from '@orca-so/whirlpools-sdk';
import { connection } from '../../connection.js';
import fs from 'fs';
import { logger } from '../../logger.js';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market } from '../types.js';
import { WhirlpoolAmm } from '@jup-ag/core';
import { AccountSubscriptionHandlersMap, geyserClient } from '../../geyser.js';
import { GeyserJupiterUpdateHandler, toPairString } from '../common.js';

type WhirlpoolData = whirpools.WhirlpoolData & {
  address: PublicKey;
};

const MAINNET_POOLS = JSON.parse(
  fs.readFileSync('./src/market_infos/orca_whirlpool/mainnet.json', 'utf-8'),
) as { whirlpools: { address: string }[] };

logger.debug(`ORCA WHIRPOOLS: Found ${MAINNET_POOLS.whirlpools.length} pools`);

const accountFetcher = new whirpools.AccountFetcher(connection);
const poolsPubkeys = MAINNET_POOLS.whirlpools.map(
  (pool) => new PublicKey(pool.address),
);
const fetchedPoolData: (whirpools.WhirlpoolData | null)[] =
  await accountFetcher.listPools(poolsPubkeys, true);

const initialAccountBuffers: Map<string, AccountInfo<Buffer>> = new Map();

for (let i = 0; i < poolsPubkeys.length; i += 100) {
  const batch = poolsPubkeys.slice(i, i + 100);
  const accounts = await connection.getMultipleAccountsInfo(batch);
  for (let j = 0; j < accounts.length; j++) {
    initialAccountBuffers.set(batch[j].toBase58(), accounts[j]);
  }
}

logger.debug(`ORCA WHIRPOOLS: Fetched ${fetchedPoolData.length} pools`);

class OrcaWhirpoolDEX extends DEX {
  pools: WhirlpoolData[];
  marketsByVault: Map<string, Market>;
  marketsToPool: Map<Market, WhirlpoolData>;
  pairToMarkets: Map<string, Market[]>;
  updateHandlerInitPromises: Promise<void>[];

  constructor() {
    super();
    this.pools = [];
    this.marketsByVault = new Map();
    this.marketsToPool = new Map();
    this.pairToMarkets = new Map();
    this.updateHandlerInitPromises = [];


    const allWhirlpoolAccountSubscriptionHandlers: AccountSubscriptionHandlersMap =
      new Map();

    for (let i = 0; i < fetchedPoolData.length; i++) {
      if (fetchedPoolData[i] !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fetchedPool = fetchedPoolData[i] as any;
        fetchedPool.address = poolsPubkeys[i];
        this.pools.push(fetchedPool as WhirlpoolData);
      }
    }

    for (const pool of this.pools) {

      const whirlpoolAmm = new WhirlpoolAmm(
        pool.address,
        initialAccountBuffers.get(pool.address.toBase58()),
      );

      const geyserUpdateHandler = new GeyserJupiterUpdateHandler(whirlpoolAmm);
      const updateHandlers = geyserUpdateHandler.getUpdateHandlers();
      updateHandlers.forEach((handler, address) => {
        allWhirlpoolAccountSubscriptionHandlers.set(address, handler);
      });
      this.updateHandlerInitPromises.push(
        geyserUpdateHandler.waitForInitialized(),
      );

      const market: Market = {
        tokenMintA: pool.tokenMintA,
        tokenVaultA: pool.tokenVaultA,
        tokenMintB: pool.tokenMintB,
        tokenVaultB: pool.tokenVaultB,
        dex: this,
        jupiter: whirlpoolAmm,
      };
      this.marketsByVault.set(pool.tokenVaultA.toBase58(), market);
      this.marketsByVault.set(pool.tokenVaultB.toBase58(), market);
      this.marketsToPool.set(market, pool);
      const pairString = toPairString(pool.tokenMintA, pool.tokenMintB);
      if (this.pairToMarkets.has(pairString)) {
        this.pairToMarkets.get(pairString).push(market);
      } else {
        this.pairToMarkets.set(pairString, [market]);
      }
    }

    geyserClient.addSubscriptions(allWhirlpoolAccountSubscriptionHandlers);
  }

  async initialize(): Promise<void> {
    await Promise.all(this.updateHandlerInitPromises);
    logger.info(`ORCA WHIRPOOLS: Initialized with: ${this.pools.length} pools`);
  }

  getMarketTokenAccountsForTokenMint(tokenMint: PublicKey): PublicKey[] {
    const tokenAccounts: PublicKey[] = [];

    for (const pool of this.pools) {
      if (pool.tokenMintA.equals(tokenMint)) {
        tokenAccounts.push(pool.tokenVaultA);
      } else if (pool.tokenMintB.equals(tokenMint)) {
        tokenAccounts.push(new PublicKey(pool.tokenVaultB));
      }
    }

    return tokenAccounts;
  }

  getMarketForVault(vault: PublicKey): Market {
    const market = this.marketsByVault.get(vault.toBase58());
    if (market === undefined) {
      throw new Error('Vault not found');
    }
    return market;
  }

  getMarketsForPair(mintA: PublicKey, mintB: PublicKey): Market[] {
    const markets = this.pairToMarkets.get(toPairString(mintA, mintB));
    if (markets === undefined) {
      return [];
    }
    return markets;
  }
}

export { OrcaWhirpoolDEX };
