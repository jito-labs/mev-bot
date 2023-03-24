import { ApiPoolInfoItem } from '@raydium-io/raydium-sdk';
import { logger } from '../../logger.js';
import fs from 'fs';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market } from '../types.js';
import { RaydiumAmm } from '@jup-ag/core';
import { connection } from '../../connection.js';

const POOLS_JSON = JSON.parse(
  fs.readFileSync('./src/market_infos/raydium/mainnet.json', 'utf-8'),
) as { official: ApiPoolInfoItem[]; unOfficial: ApiPoolInfoItem[] };

logger.debug(
  `RAYDIUM: Found ${POOLS_JSON.official.length} official pools and ${POOLS_JSON.unOfficial.length} unofficial pools`,
);

const pools: ApiPoolInfoItem[] = [];
POOLS_JSON.official.forEach((pool) => pools.push(pool));
POOLS_JSON.unOfficial.forEach((pool) => pools.push(pool));

const initialAccountBuffers: Map<string, AccountInfo<Buffer>> = new Map();
const addressesToFetch: PublicKey[] = [];

for (const pool of pools) {
  addressesToFetch.push(new PublicKey( pool.id));
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
  marketsByVault: Map<string, Market>;
  marketsToPool: Map<Market, ApiPoolInfoItem>;
  marketsToJupiter: Map<Market, RaydiumAmm>;

  constructor() {
    super();
    this.pools = pools;
    this.marketsByVault = new Map();
    this.marketsToPool = new Map();
    this.marketsToJupiter = new Map();

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

      const raydiumAmmId = new PublicKey(pool.id);
      const serumProgramId = new PublicKey(pool.marketProgramId);
      const serumMarket = new PublicKey(pool.marketId);
      const serumParams = RaydiumAmm.decodeSerumMarketKeysString(raydiumAmmId, serumProgramId, serumMarket, initialAccountBuffers.get(serumMarket.toBase58()));
      const raydiumAmm = new RaydiumAmm(raydiumAmmId, initialAccountBuffers.get(raydiumAmmId.toBase58()), serumParams);
      this.marketsToJupiter.set(market, raydiumAmm);
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
