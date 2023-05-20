import { SwapMode } from '@jup-ag/common';
import { QuoteParams } from '@jup-ag/core/dist/lib/amm.js';
import { VersionedTransaction } from '@solana/web3.js';
import { defaultImport } from 'default-import';
import jsbi from 'jsbi';
import { dropBeyondHighWaterMark } from './backpressure.js';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  calculateQuote,
  getAll2HopRoutes,
  getMarketsForPair,
} from './market-infos/index.js';
import { Market } from './market-infos/types.js';
import { BackrunnableTrade } from './post-simulation-filter.js';
import { Timings } from './types.js';
import {
  BASE_MINTS_OF_INTEREST,
  SOLEND_FLASHLOAN_FEE_BPS,
} from './constants.js';

const JSBI = defaultImport(jsbi);

const ARB_CALCULATION_NUM_STEPS = config.get('arb_calculation_num_steps');
const MAX_ARB_CALCULATION_TIME_MS = config.get('max_arb_calculation_time_ms');
const HIGH_WATER_MARK = 100;

type Route = {
  market: Market;
  fromA: boolean;
}[];

type Quote = { in: jsbi.default; out: jsbi.default };

type QuoteCache = Map<Market, Map<string, Quote>>;

type ArbIdea = {
  txn: VersionedTransaction;
  arbSize: jsbi.default;
  expectedProfit: jsbi.default;
  route: Route;
  timings: Timings;
};

async function calculateHop(
  market: Market,
  quoteParams: QuoteParams,
  cache: QuoteCache,
  timeout: number,
): Promise<Quote> {
  if (
    cache.has(market) &&
    cache.get(market).has(quoteParams.amount.toString())
  ) {
    return cache.get(market).get(quoteParams.amount.toString());
  }

  try {
    const jupQuote = await calculateQuote(market.id, quoteParams, timeout);
    if (jupQuote === null) {
      return { in: quoteParams.amount, out: JSBI.BigInt(0) };
    }

    const quote = { in: jupQuote.inAmount, out: jupQuote.outAmount };

    if (!cache.has(market)) cache.set(market, new Map());
    cache.get(market).set(quoteParams.amount.toString(), quote);

    return quote;
  } catch (e) {
    const errorString = e.toString() || '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (
      (market.dexLabel === 'Orca (Whirlpools)' &&
        errorString.includes('Swap input value traversed too many arrays')) ||
      errorString.includes('TickArray index 0 must be initialized')
    ) {
      // those errors are normal. happen when the arb size is too large
      logger.debug(
        `WhirpoolsError in calculateHop for ${market.dexLabel} ${market.id} ${e}`,
      );
    } else if (
      (market.dexLabel === 'Raydium CLMM' &&
        errorString.includes('Invalid tick array')) ||
      errorString.includes('No enough initialized tickArray')
    ) {
      logger.debug(
        `Error in calculateHop for ${market.dexLabel} ${market.id} ${e}`,
      );
    } else {
      logger.warn(
        `Error in calculateHop for ${market.dexLabel} ${market.id} ${e}`,
      );
    }
    return { in: quoteParams.amount, out: JSBI.BigInt(0) };
  }
}

function shuffle<T>(array: Array<T>) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

async function calculateRoute(
  route: Route,
  arbSize: jsbi.default,
  cache: QuoteCache,
  timeout: number,
): Promise<Quote> {
  let amount = arbSize;
  let firstIn: jsbi.default;
  for (const hop of route) {
    const quoteParams: QuoteParams = {
      amount,
      swapMode: SwapMode.ExactIn,
      sourceMint: hop.fromA ? hop.market.tokenMintA : hop.market.tokenMintB,
      destinationMint: hop.fromA
        ? hop.market.tokenMintB
        : hop.market.tokenMintA,
    };
    const quote = await calculateHop(hop.market, quoteParams, cache, timeout);
    amount = quote.out;
    if (!firstIn) firstIn = quote.in;
    if (JSBI.equal(amount, JSBI.BigInt(0))) break;
  }
  return { in: firstIn, out: amount };
}

function getProfitForQuote(quote: Quote) {
  const flashloanFee = JSBI.divide(
    JSBI.multiply(quote.in, JSBI.BigInt(SOLEND_FLASHLOAN_FEE_BPS)),
    JSBI.BigInt(10000),
  );
  const profit = JSBI.subtract(quote.out, quote.in);
  const profitMinusFlashLoanFee = JSBI.subtract(profit, flashloanFee);
  return profitMinusFlashLoanFee;
}

async function* calculateArb(
  backrunnableTradesIterator: AsyncGenerator<BackrunnableTrade>,
): AsyncGenerator<ArbIdea> {
  const backrunnableTradesIteratorGreedy = dropBeyondHighWaterMark(
    backrunnableTradesIterator,
    HIGH_WATER_MARK,
    'backrunnableTradesIterator',
  );

  for await (const {
    txn,
    market: originalMarket,
    baseIsTokenA,
    tradeDirection: originalTradeDirection,
    tradeSize,
    timings,
  } of backrunnableTradesIteratorGreedy) {
    // calculate the arb calc step size and init initial arb size to it
    const stepSize = JSBI.divide(
      JSBI.BigInt(tradeSize.toString()),
      JSBI.BigInt(ARB_CALCULATION_NUM_STEPS),
    );

    // ignore trade if minimum arb size is too small
    if (JSBI.equal(stepSize, JSBI.BigInt(0))) continue;

    // source mint is always usdc or sol
    const backrunSourceMint = baseIsTokenA
      ? originalMarket.tokenMintA
      : originalMarket.tokenMintB;

    const backrunIntermediateMint = baseIsTokenA
      ? originalMarket.tokenMintB
      : originalMarket.tokenMintA;

    // if they sold base on the original market, it means it is now cheap there and we should buy there first
    const buyOnOriginalMarketFirst = originalTradeDirection === 'SOLD_BASE';

    const marketsFor2HopBackrun = getMarketsForPair(
      backrunSourceMint,
      backrunIntermediateMint,
    );

    const marketsFor3HopBackrun = getAll2HopRoutes(
      buyOnOriginalMarketFirst ? backrunIntermediateMint : backrunSourceMint,
      buyOnOriginalMarketFirst ? backrunSourceMint : backrunIntermediateMint,
    );

    const arbRoutes: Route[] = [];

    // add 2 hop routes
    marketsFor2HopBackrun.forEach((m) => {
      const route: Route = [];
      if (buyOnOriginalMarketFirst) {
        route.push({ market: originalMarket, fromA: baseIsTokenA });
        route.push({
          market: m,
          fromA: m.tokenMintA.equals(backrunIntermediateMint),
        });
      } else {
        route.push({
          market: m,
          fromA: m.tokenMintA.equals(backrunSourceMint),
        });
        route.push({ market: originalMarket, fromA: !baseIsTokenA });
      }
      arbRoutes.push(route);
    });

    // add 3 hop routes
    // shuffle bcs not all routes may go thru (calc takes too long)
    shuffle(marketsFor3HopBackrun);
    marketsFor3HopBackrun.forEach((m) => {
      const market1 = m.hop1;
      const market2 = m.hop2;
      const route: Route = [];

      if (buyOnOriginalMarketFirst) {
        const intermediateMint1 = backrunIntermediateMint;
        const intermediateMint2 = market1.tokenMintA.equals(intermediateMint1)
          ? market1.tokenMintB
          : market1.tokenMintA;
        route.push({ market: originalMarket, fromA: baseIsTokenA });
        route.push({
          market: market1,
          fromA: market1.tokenMintA.equals(intermediateMint1),
        });
        route.push({
          market: market2,
          fromA: market2.tokenMintA.equals(intermediateMint2),
        });
      } else {
        route.push({
          market: market1,
          fromA: market1.tokenMintA.equals(backrunSourceMint),
        });
        const intermediateMint1 = market1.tokenMintA.equals(backrunSourceMint)
          ? market1.tokenMintB
          : market1.tokenMintA;
        route.push({
          market: market2,
          fromA: market2.tokenMintA.equals(intermediateMint1),
        });
        route.push({ market: originalMarket, fromA: !baseIsTokenA });
      }
      arbRoutes.push(route);
    });

    // remove all routes where a market appears twice bcs that makes no sense
    for (let i = arbRoutes.length - 1; i >= 0; i--) {
      const route = arbRoutes[i];
      const marketsInRoute = route.map((r) => r.market);
      const uniqueMarketsInRoute = new Set(marketsInRoute);
      if (uniqueMarketsInRoute.size !== marketsInRoute.length) {
        arbRoutes.splice(i, 1);
      }
    }

    logger.debug(
      `Found ${arbRoutes.length} arb routes from ${marketsFor2HopBackrun.length} 2hop and ${marketsFor3HopBackrun.length} 3hop routes`,
    );

    // init quote cache. useful for when buyOnOriginalMarketFirst is true as arb amount stays same for the first hop on each route
    const quoteCache: QuoteCache = new Map();

    const startCalculation = Date.now();

    // map of best quotes for each route
    const bestQuotes: Map<Route, Quote> = new Map();

    for (let i = 1; i <= ARB_CALCULATION_NUM_STEPS; i++) {
      let foundBetterQuote = false;
      if (Date.now() - startCalculation > MAX_ARB_CALCULATION_TIME_MS) {
        logger.info(
          `Arb calculation took too long, stopping at iteration ${i}`,
        );
        break;
      }
      const arbSize = JSBI.multiply(stepSize, JSBI.BigInt(i));

      const quotePromises: Promise<Quote>[] = [];

      for (const route of arbRoutes) {
        const remainingCalculationTime =
          MAX_ARB_CALCULATION_TIME_MS - (Date.now() - startCalculation);
        const quotePromise = calculateRoute(
          route,
          arbSize,
          quoteCache,
          remainingCalculationTime,
        );
        quotePromises.push(quotePromise);
      }

      const quotes = await Promise.all(quotePromises);

      // backwards iteration so we can remove routes that fail or are worse than previous best
      for (let i = arbRoutes.length - 1; i >= 0; i--) {
        const quote = quotes[i];

        // some markets fail when arb size is too big
        if (JSBI.equal(quote.out, JSBI.BigInt(0))) {
          arbRoutes.splice(i, 1);
          continue;
        }

        const profit = getProfitForQuote(quote);
        const prevBestQuote = bestQuotes.get(arbRoutes[i]);
        const prevBestProfit = prevBestQuote
          ? getProfitForQuote(prevBestQuote)
          : JSBI.BigInt(0);

        if (JSBI.greaterThan(profit, prevBestProfit)) {
          bestQuotes.set(arbRoutes[i], quote);
          foundBetterQuote = true;
        } else {
          arbRoutes.splice(i, 1);
        }
      }
      if (!foundBetterQuote) {
        break;
      }
    }

    // no quotes with positive profit found
    if (bestQuotes.size === 0) continue;

    logger.info(`Found ${bestQuotes.size} arb opportunities`);

    // find the best quote
    const [route, quote] = [...bestQuotes.entries()].reduce((best, current) => {
      const currentQuote = current[1];
      const currentProfit = getProfitForQuote(currentQuote);
      const bestQuote = best[1];
      const bestProfit = getProfitForQuote(bestQuote);
      if (JSBI.greaterThan(currentProfit, bestProfit)) {
        return current;
      } else {
        return best;
      }
    });
    const profit = getProfitForQuote(quote);
    const arbSize = quote.in;

    const backrunSourceMintName = BASE_MINTS_OF_INTEREST.USDC.equals(
      backrunSourceMint,
    )
      ? 'USDC'
      : 'SOL';

    const marketsString = route.reduce((acc, r) => {
      return `${acc} -> ${r.market.dexLabel}`;
    }, '');

    logger.info(
      `potential arb: profit ${profit} ${backrunSourceMintName} backrunning trade on ${originalMarket.dexLabel} ::: BUY ${arbSize} on ${marketsString}`,
    );

    yield {
      txn,
      arbSize,
      expectedProfit: profit,
      route,
      timings: {
        mempoolEnd: timings.mempoolEnd,
        preSimEnd: timings.preSimEnd,
        simEnd: timings.simEnd,
        postSimEnd: timings.postSimEnd,
        calcArbEnd: Date.now(),
        buildBundleEnd: 0,
        bundleSent: 0,
      },
    };
  }
}

export { calculateArb, ArbIdea };
