import { PublicKey } from '@solana/web3.js';
import { DEX, Market } from './types.js';
import { OrcaWhirpoolDEX } from './orca-whirlpool/index.js';
import { RaydiumDEX } from './raydium/index.js';
import { RaydiumClmmDEX } from './raydium-clmm/index.js';
import { OrcaDEX } from './orca/index.js';
import { MintMarketGraph } from './market-graph.js';
import { logger } from '../logger.js';
import { BASE_MINTS_OF_INTEREST } from '../constants.js';

const dexs: DEX[] = [
  new RaydiumDEX(),
  new OrcaWhirpoolDEX(),
  new RaydiumClmmDEX(),
  new OrcaDEX(),
];

for (const dex of dexs) {
  await dex.initialize();
}

const tokenAccountsOfInterest = new Map<string, DEX>();
const marketGraph = new MintMarketGraph();

for (const dex of dexs) {
  const usdcTokenAccounts = dex.getMarketTokenAccountsForTokenMint(
    BASE_MINTS_OF_INTEREST.USDC,
  );
  const solTokenAccounts = dex.getMarketTokenAccountsForTokenMint(
    BASE_MINTS_OF_INTEREST.SOL,
  );
  const tokenAccounts = [...usdcTokenAccounts, ...solTokenAccounts];
  for (const tokenAccount of tokenAccounts) {
    tokenAccountsOfInterest.set(tokenAccount.toBase58(), dex);
  }
  dex.getAllMarkets().forEach((market) => {
    marketGraph.addMarket(market.tokenMintA, market.tokenMintB, market);
  });
}

const isTokenAccountOfInterest = (tokenAccount: PublicKey): boolean => {
  return tokenAccountsOfInterest.has(tokenAccount.toBase58());
};

const getMarketForVault = (
  vault: PublicKey,
): { market: Market; isVaultA: boolean } => {
  const dex = tokenAccountsOfInterest.get(vault.toBase58());
  if (dex === undefined) {
    throw new Error('Vault not found');
  }
  const market = dex.getMarketForVault(vault);
  if (market === undefined) {
    throw new Error('Market not found');
  }

  return { market, isVaultA: market.tokenVaultA.equals(vault) };
};

const getMarketsForPair = (mintA: PublicKey, mintB: PublicKey): Market[] => {
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

const getAll2HopRoutes = (
  sourceMint: PublicKey,
  destinationMint: PublicKey,
): Route[] => {
  const cacheKey = `${sourceMint.toBase58()}-${destinationMint.toBase58()}`;
  if (routeCache.has(cacheKey)) {
    logger.debug(`Cache hit for ${cacheKey}`);
    return routeCache.get(cacheKey);
  }
  const sourceNeighbours = marketGraph.getNeighbours(sourceMint);
  const destNeighbours = marketGraph.getNeighbours(destinationMint);
  const intersections = new Set(
    [...sourceNeighbours]
      .filter((i) => destNeighbours.has(i))
      .map((i) => new PublicKey(i)),
  );
  const routes: {
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
      }
    }
  }
  routeCache.set(cacheKey, routes);
  return routes;
};

export {
  DEX,
  isTokenAccountOfInterest,
  getMarketForVault,
  getMarketsForPair,
  getAll2HopRoutes,
};
