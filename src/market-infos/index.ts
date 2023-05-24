import {
  AccountInfoMap,
  AddPoolResultPayload,
  AmmCalcWorkerParamMessage,
  AmmCalcWorkerResultMessage,
  CalculateQuoteResultPayload,
  CalculateRouteResultPayload,
  DEX,
  GetSwapLegAndAccountsResultPayload,
  Market,
  Quote,
  SerializableAccountInfoMap,
  SerializableRoute,
  UpdatePoolResultPayload,
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
  GeyserMultipleAccountsUpdateHandler,
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

const JSBI = defaultImport(jsbi);

const ammCalcWorkerPool = new WorkerPool(
  4,
  './build/src/market-infos/amm-calc-worker.js',
);
await ammCalcWorkerPool.initialize();
logger.info('Initialized AMM calc worker pool');

const dexs: DEX[] = [
  new OrcaDEX(),
  new OrcaWhirpoolDEX(),
  new RaydiumDEX(),
  new RaydiumClmmDEX(),
];

const accountsForGeyserUpdatePromises: Promise<{
  id: string;
  accountsForUpdate: string[];
}>[] = [];

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
      return {
        id: payload.id,
        accountsForUpdate: payload.accountsForUpdate,
      };
    });
    accountsForGeyserUpdatePromises.push(result);
  }
}

const accountsForGeyserUpdate = await Promise.all(
  accountsForGeyserUpdatePromises,
);
logger.info('Got accounts for geyser update');
const updateHandlerInits: Promise<void>[] = [];
const accountSubscriptionsHandlersMap: AccountSubscriptionHandlersMap =
  new Map();

for (const { id, accountsForUpdate } of accountsForGeyserUpdate) {
  const updateCallback = (accountInfos: AccountInfoMap) => {
    const serializableAccountInfoMap: SerializableAccountInfoMap = new Map();
    for (const [key, accountInfo] of accountInfos.entries()) {
      serializableAccountInfoMap.set(
        key,
        accountInfo === null ? null : toSerializableAccountInfo(accountInfo),
      );
    }
    const message: AmmCalcWorkerParamMessage = {
      type: 'updatePool',
      payload: {
        id,
        accountInfoMap: serializableAccountInfoMap,
      },
    };
    const results = ammCalcWorkerPool.runTaskOnAllWorkers<
      AmmCalcWorkerParamMessage,
      AmmCalcWorkerResultMessage
    >(message);

    Promise.all(results).then((results) => {
      const error = results.find((result) => {
        const payload = result.payload as UpdatePoolResultPayload;
        return payload.error !== undefined;
      });

      if (error !== undefined) {
        logger.warn(error, 'Error updating pool ' + id);
      }
    });
  };
  const handler = new GeyserMultipleAccountsUpdateHandler(
    accountsForUpdate,
    updateCallback,
  );

  const updateHandlers = handler.getUpdateHandlers();
  updateHandlers.forEach((handlers, address) => {
    if (accountSubscriptionsHandlersMap.has(address)) {
      accountSubscriptionsHandlersMap.get(address).push(...handlers);
    } else {
      accountSubscriptionsHandlersMap.set(address, handlers);
    }
  });
  updateHandlerInits.push(handler.waitForInitialized());
}

await Promise.all(updateHandlerInits);
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
