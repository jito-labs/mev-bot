import * as whirpools from '@orca-so/whirlpools-sdk';
import { connection } from '../../clients/rpc.js';
import fs from 'fs';
import { logger } from '../../logger.js';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market } from '../types.js';
import { WhirlpoolAmm } from '@jup-ag/core';
import {
  AccountSubscriptionHandlersMap,
  geyserAccountUpdateClient as geyserClient,
} from '../../clients/geyser.js';
import { GeyserJupiterUpdateHandler, toPairString } from '../common.js';

// something is wrong with the accounts of these markets
const MARKETS_TO_IGNORE = [
  'BCaq51UZ6JLpuEToQzun1GVvvqaw7Vyw8i3CzuZzBCty',
  '5dLv6NVpjUibiCgN4M9b8XFQGLikYWZKiVFhFENbkwgP',
];

type WhirlpoolData = whirpools.WhirlpoolData & {
  address: PublicKey;
};

const MAINNET_POOLS = JSON.parse(
  fs.readFileSync('./src/market-infos/orca-whirlpool/mainnet.json', 'utf-8'),
) as { whirlpools: { address: string }[] };

logger.debug(
  `Orca (Whirlpools): Found ${MAINNET_POOLS.whirlpools.length} pools`,
);

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

logger.debug(`Orca (Whirlpools): Fetched ${fetchedPoolData.length} pools`);

class OrcaWhirpoolDEX extends DEX {
  pools: WhirlpoolData[];

  constructor() {
    super('Orca (Whirlpools)');
    this.pools = [];

    const allWhirlpoolAccountSubscriptionHandlers: AccountSubscriptionHandlersMap =
      new Map();

    for (let i = 0; i < fetchedPoolData.length; i++) {
      if (fetchedPoolData[i] !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fetchedPool = fetchedPoolData[i] as any;
        fetchedPool.address = poolsPubkeys[i];
        if (MARKETS_TO_IGNORE.includes(fetchedPool.address.toBase58()))
          continue;
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
      const pairString = toPairString(pool.tokenMintA, pool.tokenMintB);
      if (this.pairToMarkets.has(pairString)) {
        this.pairToMarkets.get(pairString).push(market);
      } else {
        this.pairToMarkets.set(pairString, [market]);
      }
    }

    geyserClient.addSubscriptions(allWhirlpoolAccountSubscriptionHandlers);
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
}

export { OrcaWhirpoolDEX };
