import { SwapMode } from '@jup-ag/common';
import { VersionedTransaction } from '@solana/web3.js';
import { defaultImport } from 'default-import';
import jsbi from 'jsbi';

import { logger } from './logger.js';
import { getMarketsForPair } from './market_infos/index.js';
import { Market } from './market_infos/types.js';
import { BackrunnableTrade } from './postSimulationFilter.js';

const JSBI = defaultImport(jsbi);

const ARB_CALCULATION_FRACTION_INCREMENT = 100;

type ArbIdea = {
  txn: VersionedTransaction;
  arbSize: number;
};

async function* calculateArb(
  backrunnableTradesIterator: AsyncGenerator<BackrunnableTrade>,
): AsyncGenerator<ArbIdea> {
  for await (const {
    txn,
    market,
    aToB,
    tradeSize,
  } of backrunnableTradesIterator) {
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
    logger.info(`market ${market.jupiter.label} arb market 0 ${arbMarkets[0].jupiter.label} ${arbMarkets.indexOf(market)}`)

    let foundBetterQuote = false;

    for (let i = 1; i <= ARB_CALCULATION_FRACTION_INCREMENT; i++) {
      foundBetterQuote = false;
      arbSize = JSBI.multiply(increment, JSBI.BigInt(i));
      try {
        const hop1Quote = market.jupiter.getQuote({
          sourceMint: aToB ? market.tokenMintB : market.tokenMintA,
          destinationMint: aToB ? market.tokenMintA : market.tokenMintB,
          amount: arbSize,
          swapMode: SwapMode.ExactIn,
        });
        logger.info(`hop1Quote: ${market.jupiter.label} ${hop1Quote.inAmount} -> ${hop1Quote.outAmount}`);

        if (JSBI.equal(hop1Quote.outAmount, JSBI.BigInt(0))) break;

        for (const arbMarket of arbMarkets) {
          const hop2Quote = arbMarket.jupiter.getQuote({
            sourceMint: aToB ? market.tokenMintA : market.tokenMintB,
            destinationMint: aToB ? market.tokenMintB : market.tokenMintA,
            amount: hop1Quote.outAmount,
            swapMode: SwapMode.ExactIn,
          });
          logger.info(`hop2Quote: ${arbMarket.jupiter.label} ${hop2Quote.inAmount} -> ${hop2Quote.outAmount}`);

          const isProfitable = JSBI.GT(hop2Quote.outAmount, arbSize);
          const isBetterThanPrev = JSBI.GT(
            hop2Quote.outAmount,
            prevQuotes.get(arbMarket),
          );
          if (isProfitable && isBetterThanPrev) {
            prevQuotes.set(arbMarket, hop2Quote.outAmount);
            foundBetterQuote = true;
          }
        }
      } catch (e) {
        logger.error(e);
      }
      if (!foundBetterQuote) break;
    }

    let bestMarket: {
      market: null | Market;
      quote: jsbi.default;
    } = { market: null, quote: JSBI.BigInt(0) };
    for (const [m, q] of prevQuotes) {
      if (JSBI.GT(q, bestMarket.quote)) {
        bestMarket = { market: m, quote: q };
      }
    }
    if (bestMarket.market === null) continue;

    logger.info(
      `Found arb opportunity: profit ${JSBI.subtract(
        bestMarket.quote,
        arbSize,
      )} ${market.jupiter.label} -> ${bestMarket.market.jupiter.label} : ${
        market.tokenMintA
      } -> ${market.tokenMintB}`,
    );

    yield { txn, arbSize: JSBI.toNumber(arbSize) };
  }
}

export { calculateArb };
