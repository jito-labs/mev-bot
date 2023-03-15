import { ApiPoolInfoItem } from '@raydium-io/raydium-sdk';
import { logger } from '../../logger.js';
import fs from 'fs';
import { DEX } from '../index.js';
import { PublicKey } from '@solana/web3.js';

const MAINNET_POOLS = JSON.parse(
  fs.readFileSync('./src/market_infos/raydium/mainnet.json', 'utf-8'),
) as { official: ApiPoolInfoItem[]; unOfficial: ApiPoolInfoItem[] };

logger.debug(
  `RAYDIUM: Found ${MAINNET_POOLS.official.length} official pools and ${MAINNET_POOLS.unOfficial.length} unofficial pools`,
);

class RaydiumDEX extends DEX {
  pools: ApiPoolInfoItem[];

  constructor() {
    super();
    this.pools = [];

    MAINNET_POOLS.official.forEach((pool) => this.pools.push(pool));
    MAINNET_POOLS.unOfficial.forEach((pool) => this.pools.push(pool));

    logger.info(`RAYDIUM: Initialized with: ${this.pools.length} pools`);
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
