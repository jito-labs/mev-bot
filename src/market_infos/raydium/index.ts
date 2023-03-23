import { ApiPoolInfoItem } from '@raydium-io/raydium-sdk';
import { logger } from '../../logger.js';
import fs from 'fs';
import { PublicKey } from '@solana/web3.js';
import { DEX, Market } from '../types.js';

const MAINNET_POOLS = JSON.parse(
  fs.readFileSync('./src/market_infos/raydium/mainnet.json', 'utf-8'),
) as { official: ApiPoolInfoItem[]; unOfficial: ApiPoolInfoItem[] };

logger.debug(
  `RAYDIUM: Found ${MAINNET_POOLS.official.length} official pools and ${MAINNET_POOLS.unOfficial.length} unofficial pools`,
);

class RaydiumDEX extends DEX {
  pools: ApiPoolInfoItem[];
  marketsByVault: Map<string, Market>;
  marketsToPool: Map<Market, ApiPoolInfoItem>;

  constructor() {
    super();
    this.pools = [];
    this.marketsByVault = new Map();
    this.marketsToPool = new Map();

    MAINNET_POOLS.official.forEach((pool) => this.pools.push(pool));
    MAINNET_POOLS.unOfficial.forEach((pool) => this.pools.push(pool));

    for (const pool of this.pools) {
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
      };

      this.marketsByVault.set(poolBaseVault.toBase58(), market);
      this.marketsByVault.set(poolQuoteVault.toBase58(), market);
      this.marketsToPool.set(market, pool);
    }


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

  getMarketForVault(vault: PublicKey): Market {
    const market = this.marketsByVault.get(vault.toBase58());
    if (market === undefined) {
      throw new Error('Vault not found');
    }
    return market;
  }
}


export { RaydiumDEX };
