import { logger } from '../../logger.js';
import fs from 'fs';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market } from '../types.js';
import { RaydiumClmm } from '@jup-ag/core';
import { connection } from '../../connection.js';
import { AccountSubscriptionHandlersMap, geyserAccountUpdateClient as geyserClient } from '../../geyser.js';
import { toPairString, GeyserJupiterUpdateHandler } from '../common.js';

// something is wrong with the accounts of these markets
const MARKETS_TO_IGNORE = ['EXHyQxMSttcvLPwjENnXCPZ8GmLjJYHtNBnAkcFeFKMn'];

type PoolItem = {
  id: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
};

const POOLS_JSON = JSON.parse(
  fs.readFileSync('./src/market_infos/raydium_clmm/mainnet.json', 'utf-8'),
) as {
  data: PoolItem[];
};

logger.debug(`Raydium CLMM: Found ${POOLS_JSON.data.length} pools`);

const pools = POOLS_JSON.data;

const initialAccountBuffers: Map<string, AccountInfo<Buffer>> = new Map();
const addressesToFetch: PublicKey[] = [];

for (const pool of pools) {
  addressesToFetch.push(new PublicKey(pool.id));
}

for (let i = 0; i < addressesToFetch.length; i += 100) {
  const batch = addressesToFetch.slice(i, i + 100);
  const accounts = await connection.getMultipleAccountsInfo(batch);
  for (let j = 0; j < accounts.length; j++) {
    initialAccountBuffers.set(batch[j].toBase58(), accounts[j]);
  }
}

class RaydiumClmmDEX extends DEX {
  pools: PoolItem[];

  constructor() {
    super('Raydium CLMM');
    this.pools = pools.filter((pool) => !MARKETS_TO_IGNORE.includes(pool.id));

    const allRaydiumAccountSubscriptionHandlers: AccountSubscriptionHandlersMap =
      new Map();

    for (const pool of this.pools) {
      const raydiumClmmId = new PublicKey(pool.id);

      const raydiumClmm = new RaydiumClmm(
        raydiumClmmId,
        initialAccountBuffers.get(raydiumClmmId.toBase58()),
      );

      const geyserUpdateHandler = new GeyserJupiterUpdateHandler(raydiumClmm);
      const updateHandlers = geyserUpdateHandler.getUpdateHandlers();
      updateHandlers.forEach((handlers, address) => {
        if (allRaydiumAccountSubscriptionHandlers.has(address)) {
          allRaydiumAccountSubscriptionHandlers.get(address).push(...handlers);
        } else {
          allRaydiumAccountSubscriptionHandlers.set(address, handlers);
        }
      });
      this.updateHandlerInitPromises.push(
        geyserUpdateHandler.waitForInitialized(),
      );

      const poolBaseMint = new PublicKey(pool.mintA);
      const poolQuoteMint = new PublicKey(pool.mintB);
      const poolBaseVault = new PublicKey(pool.vaultA);
      const poolQuoteVault = new PublicKey(pool.vaultB);

      const market: Market = {
        tokenMintA: poolBaseMint,
        tokenVaultA: poolBaseVault,
        tokenMintB: poolQuoteMint,
        tokenVaultB: poolQuoteVault,
        dex: this,
        jupiter: raydiumClmm,
      };

      this.marketsByVault.set(poolBaseVault.toBase58(), market);
      this.marketsByVault.set(poolQuoteVault.toBase58(), market);
      const pairString = toPairString(poolBaseMint, poolQuoteMint);
      if (this.pairToMarkets.has(pairString)) {
        this.pairToMarkets.get(pairString).push(market);
      } else {
        this.pairToMarkets.set(pairString, [market]);
      }
    }

    geyserClient.addSubscriptions(allRaydiumAccountSubscriptionHandlers);
  }

  getMarketTokenAccountsForTokenMint(tokenMint: PublicKey): PublicKey[] {
    const tokenAccounts: PublicKey[] = [];

    for (const pool of this.pools) {
      const poolBaseMint = new PublicKey(pool.mintA);
      const poolQuoteMint = new PublicKey(pool.mintB);
      if (poolBaseMint.equals(tokenMint)) {
        tokenAccounts.push(new PublicKey(pool.vaultA));
      } else if (poolQuoteMint.equals(tokenMint)) {
        tokenAccounts.push(new PublicKey(pool.vaultB));
      }
    }

    return tokenAccounts;
  }
}

export { RaydiumClmmDEX };
