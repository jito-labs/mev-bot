import * as whirpools from '@orca-so/whirlpools-sdk';
import { connection } from '../../clients/rpc.js';
import fs from 'fs';
import { logger } from '../../logger.js';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { DEX, Market, DexLabel } from '../types.js';
import { toPairString, toSerializableAccountInfo } from '../utils.js';

// something is wrong with the accounts of these markets
const MARKETS_TO_IGNORE = [
  'BCaq51UZ6JLpuEToQzun1GVvvqaw7Vyw8i3CzuZzBCty',
  '5dLv6NVpjUibiCgN4M9b8XFQGLikYWZKiVFhFENbkwgP',
];

type WhirlpoolData = whirpools.WhirlpoolData & {
  address: PublicKey;
};

const MAINNET_POOLS = JSON.parse(
  fs.readFileSync('./src/markets/orca-whirlpool/mainnet.json', 'utf-8'),
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
    super(DexLabel.ORCA_WHIRLPOOLS);
    this.pools = [];

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
      this.ammCalcAddPoolMessages.push({
        type: 'addPool',
        payload: {
          poolLabel: this.label,
          id: pool.address.toBase58(),
          feeRateBps: Math.floor(pool.feeRate / 100),
          serializableAccountInfo: toSerializableAccountInfo(
            initialAccountBuffers.get(pool.address.toBase58()),
          ),
        },
      });

      const market: Market = {
        tokenMintA: pool.tokenMintA.toBase58(),
        tokenVaultA: pool.tokenVaultA.toBase58(),
        tokenMintB: pool.tokenMintB.toBase58(),
        tokenVaultB: pool.tokenVaultB.toBase58(),
        dexLabel: this.label,
        id: pool.address.toBase58(),
      };

      const pairString = toPairString(
        pool.tokenMintA.toBase58(),
        pool.tokenMintB.toBase58(),
      );
      if (this.pairToMarkets.has(pairString)) {
        this.pairToMarkets.get(pairString).push(market);
      } else {
        this.pairToMarkets.set(pairString, [market]);
      }
    }
  }
}

export { OrcaWhirpoolDEX };
