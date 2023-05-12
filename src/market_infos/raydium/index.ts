import { ApiPoolInfoItem } from '@raydium-io/raydium-sdk';
import { logger } from '../../logger.js';
import fs from 'fs';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market } from '../types.js';
import { RaydiumAmm } from '@jup-ag/core';
import { connection } from '../../clients/rpc.js';
import {
  AccountSubscriptionHandlersMap,
  geyserAccountUpdateClient as geyserClient,
} from '../../clients/geyser.js';
import { toPairString, GeyserJupiterUpdateHandler } from '../common.js';

// something is wrong with the accounts of these markets
const MARKETS_TO_IGNORE = [
  '9DTY3rv8xRa3CnoPoWJCMcQUSY7kUHZAoFKNsBhx8DDz',
  '2EXiumdi14E9b8Fy62QcA5Uh6WdHS2b38wtSxp72Mibj',
  '9f4FtV6ikxUZr8fAjKSGNPPnUHJEwi4jNk8d79twbyFf',
  '5NBtQe4GPZTRiwrmkwPxNdAuiVFGjQWnihVSqML6ADKT', // pool not tradeable
];

const POOLS_JSON = JSON.parse(
  fs.readFileSync('./src/market_infos/raydium/mainnet.json', 'utf-8'),
) as { official: ApiPoolInfoItem[]; unOfficial: ApiPoolInfoItem[] };

logger.debug(
  `Raydium: Found ${POOLS_JSON.official.length} official pools and ${POOLS_JSON.unOfficial.length} unofficial pools`,
);

const pools: ApiPoolInfoItem[] = [];
POOLS_JSON.official.forEach((pool) => pools.push(pool));
POOLS_JSON.unOfficial.forEach((pool) => pools.push(pool));

const initialAccountBuffers: Map<string, AccountInfo<Buffer>> = new Map();
const addressesToFetch: PublicKey[] = [];

for (const pool of pools) {
  addressesToFetch.push(new PublicKey(pool.id));
  addressesToFetch.push(new PublicKey(pool.marketId));
}

for (let i = 0; i < addressesToFetch.length; i += 100) {
  const batch = addressesToFetch.slice(i, i + 100);
  const accounts = await connection.getMultipleAccountsInfo(batch);
  for (let j = 0; j < accounts.length; j++) {
    initialAccountBuffers.set(batch[j].toBase58(), accounts[j]);
  }
}

class RaydiumDEX extends DEX {
  pools: ApiPoolInfoItem[];

  constructor() {
    super('Raydium');
    this.pools = pools.filter((pool) => !MARKETS_TO_IGNORE.includes(pool.id));

    const allRaydiumAccountSubscriptionHandlers: AccountSubscriptionHandlersMap =
      new Map();

    for (const pool of this.pools) {
      const raydiumAmmId = new PublicKey(pool.id);

      const serumProgramId = new PublicKey(pool.marketProgramId);
      const serumMarket = new PublicKey(pool.marketId);
      const serumParams = RaydiumAmm.decodeSerumMarketKeysString(
        raydiumAmmId,
        serumProgramId,
        serumMarket,
        initialAccountBuffers.get(serumMarket.toBase58()),
      );

      const raydiumAmm = new RaydiumAmm(
        raydiumAmmId,
        initialAccountBuffers.get(raydiumAmmId.toBase58()),
        serumParams,
      );

      const geyserUpdateHandler = new GeyserJupiterUpdateHandler(raydiumAmm);
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

      const poolBaseMint = new PublicKey(pool.baseMint);
      const poolQuoteMint = new PublicKey(pool.quoteMint);
      const poolBaseVault = new PublicKey(pool.baseVault);
      const poolQuoteVault = new PublicKey(pool.quoteVault);

      const market: Market = {
        tokenMintA: poolBaseMint,
        tokenVaultA: poolBaseVault,
        tokenMintB: poolQuoteMint,
        tokenVaultB: poolQuoteVault,
        dex: this,
        jupiter: raydiumAmm,
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
      const poolBaseMint = new PublicKey(pool.baseMint);
      const poolQuoteMint = new PublicKey(pool.quoteMint);
      if (poolBaseMint.equals(tokenMint)) {
        tokenAccounts.push(new PublicKey(pool.baseVault));
      } else if (poolQuoteMint.equals(tokenMint)) {
        tokenAccounts.push(new PublicKey(pool.quoteVault));
      }
    }

    return tokenAccounts;
  }
}

export { RaydiumDEX };
