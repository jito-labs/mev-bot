import fs from 'fs';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market } from '../types.js';
import { SplTokenSwapAmm } from '@jup-ag/core';
import { connection } from '../../connection.js';
import { AccountSubscriptionHandlersMap, geyserAccountUpdateClient as geyserClient } from '../../geyser.js';
import { toPairString, GeyserJupiterUpdateHandler } from '../common.js';
import { TokenSwapLayout } from './layout.js';
import { logger } from '../../logger.js';

// something is wrong with the accounts of these markets
const MARKETS_TO_IGNORE = [];

type PoolItem = {
  poolAccount: string;
};

type ParsedPoolItem = {
  id: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
};

const POOLS_JSON = JSON.parse(
  fs.readFileSync('./src/market_infos/orca/mainnet.json', 'utf-8'),
) as {
  [name: string]: PoolItem;
};

const pools = Object.values(POOLS_JSON);

const initialAccountBuffers: Map<string, AccountInfo<Buffer>> = new Map();
const addressesToFetch: PublicKey[] = [];

for (const pool of pools) {
  addressesToFetch.push(new PublicKey(pool.poolAccount));
}

for (let i = 0; i < addressesToFetch.length; i += 100) {
  const batch = addressesToFetch.slice(i, i + 100);
  const accounts = await connection.getMultipleAccountsInfo(batch);
  for (let j = 0; j < accounts.length; j++) {
    initialAccountBuffers.set(batch[j].toBase58(), accounts[j]);
  }
}

class OrcaDEX extends DEX {
  pools: ParsedPoolItem[];

  constructor() {
    super('Orca');
    this.pools = pools
      .filter((pool) => !MARKETS_TO_IGNORE.includes(pool.poolAccount))
      .map((pool) => {
        const buffer = initialAccountBuffers.get(pool.poolAccount);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = TokenSwapLayout.decode(buffer.data) as any;
        const parsedPool =  {
          id: new PublicKey(pool.poolAccount),
          mintA: new PublicKey(data.mintA),
          mintB: new PublicKey(data.mintB),
          vaultA: new PublicKey(data.tokenAccountA),
          vaultB: new PublicKey(data.tokenAccountB),
        };
        logger.debug(parsedPool, 'Orca parsed pool: ');
        return parsedPool;
      });

    const allAccountSubscriptionHandlers: AccountSubscriptionHandlersMap =
      new Map();

    for (const pool of this.pools) {
      const swapAmm = new SplTokenSwapAmm(
        pool.id,
        initialAccountBuffers.get(pool.id.toBase58()),
        'Orca',
      );

      const geyserUpdateHandler = new GeyserJupiterUpdateHandler(swapAmm);
      const updateHandlers = geyserUpdateHandler.getUpdateHandlers();
      updateHandlers.forEach((handlers, address) => {
        if (allAccountSubscriptionHandlers.has(address)) {
          allAccountSubscriptionHandlers.get(address).push(...handlers);
        } else {
          allAccountSubscriptionHandlers.set(address, handlers);
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
        jupiter: swapAmm,
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

    geyserClient.addSubscriptions(allAccountSubscriptionHandlers);
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

export { OrcaDEX };
