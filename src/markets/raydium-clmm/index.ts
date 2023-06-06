import { logger } from '../../logger.js';
import fs from 'fs';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market, DexLabel } from '../types.js';
import { connection } from '../../clients/rpc.js';
import { toPairString, toSerializableAccountInfo } from '../utils.js';

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
  fs.readFileSync('./src/markets/raydium-clmm/mainnet.json', 'utf-8'),
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
    super(DexLabel.RAYDIUM_CLMM);
    this.pools = pools.filter((pool) => !MARKETS_TO_IGNORE.includes(pool.id));
    for (const pool of this.pools) {
      this.ammCalcAddPoolMessages.push({
        type: 'addPool',
        payload: {
          poolLabel: this.label,
          id: pool.id,
          serializableAccountInfo: toSerializableAccountInfo(
            initialAccountBuffers.get(pool.id),
          ),
        },
      });

      const market: Market = {
        tokenMintA: pool.mintA,
        tokenVaultA: pool.vaultA,
        tokenMintB: pool.mintB,
        tokenVaultB: pool.vaultB,
        dexLabel: this.label,
        id: pool.id,
      };

      this.marketsByVault.set(pool.vaultA, market);
      this.marketsByVault.set(pool.vaultB, market);
      const pairString = toPairString(pool.mintA, pool.mintB);
      if (this.pairToMarkets.has(pairString)) {
        this.pairToMarkets.get(pairString).push(market);
      } else {
        this.pairToMarkets.set(pairString, [market]);
      }
    }
  }

  getMarketTokenAccountsForTokenMint(tokenMint: string): string[] {
    const tokenAccounts: string[] = [];

    for (const pool of this.pools) {
      if (pool.mintA === tokenMint) {
        tokenAccounts.push(pool.vaultA);
      } else if (pool.mintB === tokenMint) {
        tokenAccounts.push(pool.vaultB);
      }
    }

    return tokenAccounts;
  }
}

export { RaydiumClmmDEX };
