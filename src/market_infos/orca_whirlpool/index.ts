import * as whirpools from '@orca-so/whirlpools-sdk';
import { connection } from '../../connection.js';
import fs from 'fs';
import { logger } from '../../logger.js';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market } from '../types.js';
import { WhirlpoolAmm } from '@jup-ag/core';

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
  marketsToJupiter: Map<Market, WhirlpoolAmm>;

  constructor() {
    super();
    this.pools = [];
    this.marketsByVault = new Map();
    this.marketsToPool = new Map();
    this.marketsToJupiter = new Map();
    
    for (let i = 0; i < fetchedPoolData.length; i++) {
      if (fetchedPoolData[i] !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fetchedPool = fetchedPoolData[i] as any;
        fetchedPool.address = poolsPubkeys[i];
        this.pools.push(fetchedPool as WhirlpoolData);
      }
    }

    for (const pool of this.pools) {
      const market: Market = {
        tokenMintA: pool.tokenMintA,
        tokenVaultA: pool.tokenVaultA,
        tokenMintB: pool.tokenMintB,
        tokenVaultB: pool.tokenVaultB,
        dex: this,
      };
      this.marketsByVault.set(pool.tokenVaultA.toBase58(), market);
      this.marketsByVault.set(pool.tokenVaultB.toBase58(), market);
      this.marketsToPool.set(market, pool);

      const whirlpoolAmm = new WhirlpoolAmm(pool.address, initialAccountBuffers.get(pool.address.toBase58()));
      this.marketsToJupiter.set(market, whirlpoolAmm);
    }

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
}

export { OrcaWhirpoolDEX };
