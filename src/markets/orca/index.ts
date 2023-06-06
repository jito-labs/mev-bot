import fs from 'fs';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market, DexLabel } from '../types.js';
import { connection } from '../../clients/rpc.js';
import { toPairString, toSerializableAccountInfo } from '../utils.js';
import { TokenSwapLayout } from './layout.js';
import { logger } from '../../logger.js';

// something is wrong with the accounts of these markets
const MARKETS_TO_IGNORE = [];

type PoolItem = {
  poolAccount: string;
};

type ParsedPoolItem = {
  id: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
};

const POOLS_JSON = JSON.parse(
  fs.readFileSync('./src/markets/orca/mainnet.json', 'utf-8'),
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
    super(DexLabel.ORCA);
    this.pools = pools
      .filter((pool) => !MARKETS_TO_IGNORE.includes(pool.poolAccount))
      .map((pool) => {
        const buffer = initialAccountBuffers.get(pool.poolAccount);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = TokenSwapLayout.decode(buffer.data) as any;
        const parsedPool = {
          id: pool.poolAccount,
          mintA: data.mintA.toBase58(),
          mintB: data.mintB.toBase58(),
          vaultA: data.tokenAccountA.toBase58(),
          vaultB: data.tokenAccountB.toBase58(),
        };
        logger.debug(parsedPool, 'Orca parsed pool: ');
        return parsedPool;
      });

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

export { OrcaDEX };
