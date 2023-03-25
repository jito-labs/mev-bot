import { SwapMode } from '@jup-ag/common';
import { QuoteParams } from '@jup-ag/core/dist/lib/amm.js';
import { VersionedTransaction } from '@solana/web3.js';
import { defaultImport } from 'default-import';
import jsbi from 'jsbi';

import { logger } from './logger.js';
import { getMarketsForPair } from './market_infos/index.js';
import { Market } from './market_infos/types.js';
import { BackrunnableTrade } from './postSimulationFilter.js';
import { Timings } from './types.js';

const JSBI = defaultImport(jsbi);

const ARB_CALCULATION_FRACTION_INCREMENT = 100;

type ArbIdea = {
  txn: VersionedTransaction;
  arbSize: number;
  timings: Timings;
};

function calculateHop(market: Market, quoteParams: QuoteParams): jsbi.default {
  try {
    const quote = market.jupiter.getQuote(quoteParams);
    return quote.outAmount;
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((e as any).errorCode === 'TickArraySequenceInvalid') {
      logger.debug(
        `WhirpoolsError TickArraySequenceInvalid in calculateArb ${e}`,
      );
    } else {
      logger.error(e);
    }
    return JSBI.BigInt(0);
  }
}

async function* calculateArb(
  backrunnableTradesIterator: AsyncGenerator<BackrunnableTrade>,
): AsyncGenerator<ArbIdea> {
  for await (const {
    txn,
    market,
    aToB,
    tradeSize,
    timings,
  } of backrunnableTradesIterator) {
    const start = Date.now();
    const arbMarkets = getMarketsForPair(market.tokenMintA, market.tokenMintB);
    const currentMarketIndex = arbMarkets.indexOf(market);
    arbMarkets.splice(currentMarketIndex, 1);
    if (arbMarkets.length === 0) {
      continue;
    }

    JSBI.BigInt(0);
    const increment = JSBI.BigInt((tradeSize / 100n).toString());
    let arbSize = increment;
    if (JSBI.equal(increment, JSBI.BigInt(0))) continue;

    const prevQuotes: Map<Market, jsbi.default> = new Map();
    arbMarkets.forEach((m) => prevQuotes.set(m, JSBI.BigInt(0)));

    let foundBetterArb = false;

    for (let i = 1; i <= ARB_CALCULATION_FRACTION_INCREMENT; i++) {
      foundBetterArb = false;
      arbSize = JSBI.multiply(increment, JSBI.BigInt(i));
      const hop1Quote = calculateHop(market, {
        sourceMint: aToB ? market.tokenMintB : market.tokenMintA,
        destinationMint: aToB ? market.tokenMintA : market.tokenMintB,
        amount: arbSize,
        swapMode: SwapMode.ExactIn,
      });

      if (JSBI.equal(hop1Quote, JSBI.BigInt(0))) break;

      for (const arbMarket of arbMarkets) {
        const hop2Quote = calculateHop(arbMarket, {
          sourceMint: aToB ? market.tokenMintA : market.tokenMintB,
          destinationMint: aToB ? market.tokenMintB : market.tokenMintA,
          amount: hop1Quote,
          swapMode: SwapMode.ExactIn,
        });

        const profit = JSBI.subtract(hop2Quote, arbSize);

        logger.info(
          `${i}% size: ${market.jupiter.label} -> ${arbMarket.jupiter.label} ${arbSize} -> ${hop1Quote} -> ${hop2Quote} = ${profit}`,
        );

        const isBetterThanPrev = JSBI.GT(profit, prevQuotes.get(arbMarket));
        if (isBetterThanPrev) {
          prevQuotes.set(arbMarket, profit);
          foundBetterArb = true;
        } else {
          const currentArbMarketIndex = arbMarkets.indexOf(arbMarket);
          arbMarkets.splice(currentArbMarketIndex, 1);
        }
      }
      if (!foundBetterArb) break;
    }

    arbSize = JSBI.subtract(arbSize, increment);

    let bestMarket: {
      market: null | Market;
      profit: jsbi.default;
    } = { market: null, profit: JSBI.BigInt(0) };
    for (const [m, q] of prevQuotes) {
      if (JSBI.GT(q, bestMarket.profit)) {
        bestMarket = { market: m, profit: q };
      }
    }
    if (bestMarket.market === null) continue;

    logger.warn(
      `Found arb opportunity in ${Date.now() - start}ms: profit ${
        bestMarket.profit
      } ${market.jupiter.label} -> ${bestMarket.market.jupiter.label} : ${
        market.tokenMintA
      } -> ${market.tokenMintB}`,
    );

    yield {
      txn,
      arbSize: JSBI.toNumber(arbSize),
      timings: {
        mempoolEnd: timings.mempoolEnd,
        preSimEnd: timings.preSimEnd,
        simEnd: timings.simEnd,
        postSimEnd: timings.postSimEnd,
        calcArbEnd: Date.now(),
      },
    };
  }
}

export { calculateArb };
