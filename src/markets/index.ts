import {
  AccountUpdateResultPayload,
  AddPoolResultPayload,
  AmmCalcWorkerParamMessage,
  AmmCalcWorkerResultMessage,
  CalculateQuoteResultPayload,
  CalculateRouteResultPayload,
  DEX,
  GetSwapLegAndAccountsResultPayload,
  Market,
  Quote,
  SerializableRoute,
} from './types.js';
import { OrcaDEX } from './orca/index.js';
import { MintMarketGraph } from './market-graph.js';
import { logger } from '../logger.js';
import { BASE_MINTS_OF_INTEREST } from '../constants.js';
import { WorkerPool } from '../worker-pool.js';
import { OrcaWhirpoolDEX } from './orca-whirlpool/index.js';
import {
  Quote as JupiterQuote,
  QuoteParams,
  SwapLegAndAccounts,
  SwapParams,
} from '@jup-ag/core/dist/lib/amm.js';
import {
  toAccountMeta,
  toJupiterQuote,
  toSerializableAccountInfo,
  toSerializableQuoteParams,
  toSerializableSwapParams,
} from './utils.js';
import { RaydiumDEX } from './raydium/index.js';
import { RaydiumClmmDEX } from './raydium-clmm/index.js';
import {
  AccountSubscriptionHandlersMap,
  geyserAccountUpdateClient,
} from '../clients/geyser.js';
import { defaultImport } from 'default-import';
import jsbi from 'jsbi';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { connection } from '../clients/rpc.js';
import { config } from '../config.js';

const JSBI = defaultImport(jsbi);

const NUM_WORKER_THREADS = config.get('num_worker_threads');

const ammCalcWorkerPool = new WorkerPool(
  NUM_WORKER_THREADS,
  './build/src/markets/amm-calc-worker.js',
);
await ammCalcWorkerPool.initialize();
logger.info('Initialized AMM calc worker pool');

const dexs: DEX[] = [
  new OrcaDEX(),
  new OrcaWhirpoolDEX(),
  new RaydiumDEX(),
  new RaydiumClmmDEX(),
];

const accountsForGeyserUpdatePromises: Promise<string[]>[] = [];

for (const dex of dexs) {
  for (const addPoolMessage of dex.getAmmCalcAddPoolMessages()) {
    const results = ammCalcWorkerPool.runTaskOnAllWorkers<
      AmmCalcWorkerParamMessage,
      AmmCalcWorkerResultMessage
    >(addPoolMessage);
    const result = Promise.race(results).then((result) => {
      if (result.type !== 'addPool') {
        throw new Error('Unexpected result type in addPool response');
      }
      const payload = result.payload as AddPoolResultPayload;
      return payload.accountsForUpdate;
    });
    accountsForGeyserUpdatePromises.push(result);
  }
}

const accountsForGeyserUpdate = await Promise.all(
  accountsForGeyserUpdatePromises,
);
const accountsForGeyserUpdateFlat = accountsForGeyserUpdate.flat();
const accountsForGeyserUpdateSet = new Set(accountsForGeyserUpdateFlat);

logger.info('Got account list for pools');

const initialAccountBuffers: Map<string, AccountInfo<Buffer> | null> =
  new Map();
const addressesToFetch: PublicKey[] = [...accountsForGeyserUpdateSet].map(
  (a) => new PublicKey(a),
);

const fetchAccountPromises: Promise<void>[] = [];
for (let i = 0; i < addressesToFetch.length; i += 25) {
  const batch = addressesToFetch.slice(i, i + 25);
  const promise = connection.getMultipleAccountsInfo(batch).then((accounts) => {
    for (let j = 0; j < accounts.length; j++) {
      initialAccountBuffers.set(batch[j].toBase58(), accounts[j]);
    }
  });
  fetchAccountPromises.push(promise);
}

await Promise.all(fetchAccountPromises);

const seedAccountInfoPromises: Promise<AmmCalcWorkerResultMessage>[] = [];

// seed account info in workers
for (const [id, accountInfo] of initialAccountBuffers) {
  const message: AmmCalcWorkerParamMessage = {
    type: 'accountUpdate',
    payload: {
      id,
      accountInfo: accountInfo ? toSerializableAccountInfo(accountInfo) : null,
    },
  };
  const results = ammCalcWorkerPool.runTaskOnAllWorkers<
    AmmCalcWorkerParamMessage,
    AmmCalcWorkerResultMessage
  >(message);
  seedAccountInfoPromises.push(...results);
}

await Promise.all(seedAccountInfoPromises);

logger.info('Seeded account info in workers');

const accountSubscriptionsHandlersMap: AccountSubscriptionHandlersMap =
  new Map();
// set up geyser subs
for (const account of accountsForGeyserUpdateSet) {
  const callback = async (accountInfo: AccountInfo<Buffer>) => {
    const message: AmmCalcWorkerParamMessage = {
      type: 'accountUpdate',
      payload: {
        id: account,
        accountInfo: toSerializableAccountInfo(accountInfo),
      },
    };
    const resultPromises = ammCalcWorkerPool.runTaskOnAllWorkers<
      AmmCalcWorkerParamMessage,
      AmmCalcWorkerResultMessage
    >(message);
    const results = await Promise.all(resultPromises);

    const error = results.find((result) => {
      const payload = result.payload as AccountUpdateResultPayload;
      return payload.error === true;
    });

    if (error) {
      logger.warn(
        `Error updating pool account ${account}, re-seeding with data from rpc`,
      );
      const accountInfo = await connection.getAccountInfo(
        new PublicKey(account),
      );
      const message: AmmCalcWorkerParamMessage = {
        type: 'accountUpdate',
        payload: {
          id: account,
          accountInfo: toSerializableAccountInfo(accountInfo),
        },
      };
      ammCalcWorkerPool.runTaskOnAllWorkers<
        AmmCalcWorkerParamMessage,
        AmmCalcWorkerResultMessage
      >(message);
    }
  };
  accountSubscriptionsHandlersMap.set(account, [callback]);
}

geyserAccountUpdateClient.addSubscriptions(accountSubscriptionsHandlersMap);
logger.info('Initialized geyser update handlers');

const tokenAccountsOfInterest = new Map<string, DEX>();
const marketGraph = new MintMarketGraph();

for (const dex of dexs) {
  const usdcTokenAccounts = dex.getMarketTokenAccountsForTokenMint(
    BASE_MINTS_OF_INTEREST.USDC.toBase58(),
  );
  const solTokenAccounts = dex.getMarketTokenAccountsForTokenMint(
    BASE_MINTS_OF_INTEREST.SOL.toBase58(),
  );
  const tokenAccounts = [...usdcTokenAccounts, ...solTokenAccounts];
  for (const tokenAccount of tokenAccounts) {
    tokenAccountsOfInterest.set(tokenAccount, dex);
  }
  dex.getAllMarkets().forEach((market) => {
    marketGraph.addMarket(market.tokenMintA, market.tokenMintB, market);
  });
}

const isTokenAccountOfInterest = (tokenAccount: string): boolean => {
  return tokenAccountsOfInterest.has(tokenAccount);
};

function getMarketForVault(vault: string): {
  market: Market;
  isVaultA: boolean;
} {
  const dex = tokenAccountsOfInterest.get(vault);
  if (dex === undefined) {
    throw new Error('Vault not found');
  }
  const market = dex.getMarketForVault(vault);
  if (market === undefined) {
    throw new Error('Market not found');
  }

  return { market, isVaultA: market.tokenVaultA === vault };
}

const getMarketsForPair = (mintA: string, mintB: string): Market[] => {
  const markets: Market[] = [];
  for (const dex of dexs) {
    markets.push(...dex.getMarketsForPair(mintA, mintB));
  }
  return markets;
};

type Route = {
  hop1: Market;
  hop2: Market;
};

const routeCache: Map<string, Route[]> = new Map();

function getAll2HopRoutes(
  sourceMint: string,
  destinationMint: string,
): Route[] {
  const cacheKey = `${sourceMint}-${destinationMint}`;
  const cacheKeyReverse = `${destinationMint}-${sourceMint}`;

  if (routeCache.has(cacheKey)) {
    logger.debug(`Cache hit for ${cacheKey}`);
    return routeCache.get(cacheKey);
  }
  const sourceNeighbours = marketGraph.getNeighbours(sourceMint);
  const destNeighbours = marketGraph.getNeighbours(destinationMint);
  let intersections: Set<string> = new Set();
  if (sourceNeighbours.size < destNeighbours.size) {
    intersections = new Set(
      [...sourceNeighbours].filter((i) => destNeighbours.has(i)),
    );
  } else {
    intersections = new Set(
      [...destNeighbours].filter((i) => sourceNeighbours.has(i)),
    );
  }

  const routes: {
    hop1: Market;
    hop2: Market;
  }[] = [];
  const routesReverse: {
    hop1: Market;
    hop2: Market;
  }[] = [];

  for (const intersection of intersections) {
    const hop1 = marketGraph.getMarkets(sourceMint, intersection);
    const hop2 = marketGraph.getMarkets(intersection, destinationMint);
    for (const hop1Market of hop1) {
      for (const hop2Market of hop2) {
        routes.push({
          hop1: hop1Market,
          hop2: hop2Market,
        });
        routesReverse.push({
          hop1: hop2Market,
          hop2: hop1Market,
        });
      }
    }
  }
  routeCache.set(cacheKey, routes);
  routeCache.set(cacheKeyReverse, routesReverse);
  return routes;
}

async function calculateQuote(
  poolId: string,
  params: QuoteParams,
  timeout?: number,
  prioritze?: boolean,
): Promise<JupiterQuote | null> {
  logger.debug(`Calculating quote for ${poolId} ${JSON.stringify(params)}`);
  const serializableQuoteParams = toSerializableQuoteParams(params);
  const message: AmmCalcWorkerParamMessage = {
    type: 'calculateQuote',
    payload: {
      id: poolId,
      params: serializableQuoteParams,
    },
  };

  const result = await ammCalcWorkerPool.runTask<
    AmmCalcWorkerParamMessage,
    AmmCalcWorkerResultMessage
  >(message, timeout, prioritze);
  if (result === null) return null;
  const payload = result.payload as CalculateQuoteResultPayload;
  if (payload.error !== undefined) throw payload.error;

  const serializableQuote = payload.quote;
  const quote = toJupiterQuote(serializableQuote);
  return quote;
}

async function calculateSwapLegAndAccounts(
  poolId: string,
  params: SwapParams,
  timeout?: number,
  prioritze?: boolean,
): Promise<SwapLegAndAccounts> {
  logger.debug(
    `Calculating SwapLegAndAccounts for ${poolId} ${JSON.stringify(params)}`,
  );
  const serializableSwapParams = toSerializableSwapParams(params);
  const message: AmmCalcWorkerParamMessage = {
    type: 'getSwapLegAndAccounts',
    payload: {
      id: poolId,
      params: serializableSwapParams,
    },
  };
  const result = await ammCalcWorkerPool.runTask<
    AmmCalcWorkerParamMessage,
    AmmCalcWorkerResultMessage
  >(message, timeout, prioritze);

  const payload = result.payload as GetSwapLegAndAccountsResultPayload;
  const [leg, accounts] = payload.swapLegAndAccounts;
  return [leg, accounts.map(toAccountMeta)];
}

async function calculateRoute(
  route: SerializableRoute,
  timeout?: number,
): Promise<Quote | null> {
  const message: AmmCalcWorkerParamMessage = {
    type: 'calculateRoute',
    payload: { route },
  };
  const result = await ammCalcWorkerPool.runTask<
    AmmCalcWorkerParamMessage,
    AmmCalcWorkerResultMessage
  >(message, timeout);

  if (result === null) return null;

  const payload = result.payload as CalculateRouteResultPayload;
  const serializableQuote = payload.quote;

  return {
    in: JSBI.BigInt(serializableQuote.in),
    out: JSBI.BigInt(serializableQuote.out),
  };
}

export {
  DEX,
  isTokenAccountOfInterest,
  getMarketForVault,
  getMarketsForPair,
  getAll2HopRoutes,
  calculateQuote,
  calculateSwapLegAndAccounts,
  calculateRoute,
};
