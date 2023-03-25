import { SwapMode } from '@jup-ag/common';
import { QuoteParams } from '@jup-ag/core/dist/lib/amm.js';
import { VersionedTransaction } from '@solana/web3.js';
import { defaultImport } from 'default-import';
import jsbi from 'jsbi';
import { config } from './config.js';

import { logger } from './logger.js';
import { getMarketsForPair } from './market_infos/index.js';
import { BASE_MINTS_OF_INTEREST, Market } from './market_infos/types.js';
import { BackrunnableTrade } from './postSimulationFilter.js';
import { Timings } from './types.js';

const JSBI = defaultImport(jsbi);

const ARB_CALCULATION_NUM_STEPS = config.get('arb_calculation_num_steps');

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
      // those errors are normal. happen when the arb size is too large
      logger.debug(
        `WhirpoolsError TickArraySequenceInvalid in calculateHop for ${market.jupiter.label} ${market.jupiter.id} ${e}`,
      );
    } else {
      logger.warn(
        `Error in calculateHop for ${market.jupiter.label} ${market.jupiter.id} ${e}`,
      );
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
    isVaultA,
    buyOnCurrentMarket,
    tradeSize,
    timings,
  } of backrunnableTradesIterator) {
    const arbMarkets = getMarketsForPair(market.tokenMintA, market.tokenMintB);

    // remove current market from list of arb markets - no point in buying back on the same market
    const currentMarketIndex = arbMarkets.indexOf(market);
    arbMarkets.splice(currentMarketIndex, 1);
    if (arbMarkets.length === 0) {
      continue;
    }

    // calculate the arb calc step size and init initial arb size to it
    const stepSize = JSBI.divide(
      JSBI.BigInt(tradeSize.toString()),
      JSBI.BigInt(ARB_CALCULATION_NUM_STEPS),
    );
    let arbSize = stepSize;

    // ignore trade if minimum arb size is too small
    if (JSBI.equal(arbSize, JSBI.BigInt(0))) continue;

    // init map of potential profit on each market
    const prevQuotes: Map<Market, jsbi.default> = new Map();
    arbMarkets.forEach((m) => prevQuotes.set(m, JSBI.BigInt(0)));

    // flag to know when to stop looking for better arbs
    let foundBetterArb = false;

    const sourceMint = isVaultA ? market.tokenMintA : market.tokenMintB;
    const intermediateMint = isVaultA ? market.tokenMintB : market.tokenMintA;
    const destinationMint = sourceMint;

    const sourceMintName = BASE_MINTS_OF_INTEREST.USDC.equals(sourceMint)
      ? 'USDC'
      : 'SOL';

    if (buyOnCurrentMarket) {
      for (let i = 1; i <= ARB_CALCULATION_NUM_STEPS; i++) {
        foundBetterArb = false;
        arbSize = JSBI.multiply(stepSize, JSBI.BigInt(i));
        const hop1Quote = calculateHop(market, {
          sourceMint: sourceMint,
          destinationMint: intermediateMint,
          amount: arbSize,
          swapMode: SwapMode.ExactIn,
        });

        if (JSBI.equal(hop1Quote, JSBI.BigInt(0))) break;

        for (const arbMarket of arbMarkets) {
          const hop2Quote = calculateHop(arbMarket, {
            sourceMint: intermediateMint,
            destinationMint: destinationMint,
            amount: hop1Quote,
            swapMode: SwapMode.ExactIn,
          });

          const profit = JSBI.subtract(hop2Quote, arbSize);

          logger.debug(
            `${i} step: ${market.jupiter.label} -> ${arbMarket.jupiter.label} ${arbSize} -> ${hop1Quote} -> ${hop2Quote} = ${profit}`,
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
    } else {
      for (let i = 1; i <= ARB_CALCULATION_NUM_STEPS; i++) {
        foundBetterArb = false;
        arbSize = JSBI.multiply(stepSize, JSBI.BigInt(i));

        for (const arbMarket of arbMarkets) {
          const hop1Quote = calculateHop(arbMarket, {
            sourceMint: sourceMint,
            destinationMint: intermediateMint,
            amount: arbSize,
            swapMode: SwapMode.ExactIn,
          });

          if (JSBI.equal(hop1Quote, JSBI.BigInt(0))) {
            const currentArbMarketIndex = arbMarkets.indexOf(arbMarket);
            arbMarkets.splice(currentArbMarketIndex, 1);
            continue;
          }

          const hop2Quote = calculateHop(market, {
            sourceMint: intermediateMint,
            destinationMint: destinationMint,
            amount: hop1Quote,
            swapMode: SwapMode.ExactIn,
          });

          const profit = JSBI.subtract(hop2Quote, arbSize);

          logger.debug(
            `${i} step: ${arbMarket.jupiter.label} -> ${market.jupiter.label} : ${arbSize} -> ${hop1Quote} -> ${hop2Quote} = ${profit}`,
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
    }

    // substract one step size from arb size to get the actual arb size bcs the last loop iteration does not contain more profitable arbs
    arbSize = JSBI.subtract(arbSize, stepSize);

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

    logger.info(
      `ARB: profit ${
        bestMarket.profit
      } ${sourceMintName} backrunning trade on ${
        market.jupiter.label
      } ::: BUY ${arbSize} on ${
        buyOnCurrentMarket
          ? market.jupiter.label
          : bestMarket.market.jupiter.label
      } -> ${intermediateMint} -> ${JSBI.add(
        arbSize,
        bestMarket.profit,
      )} on ${
        buyOnCurrentMarket
          ? bestMarket.market.jupiter.label
          : market.jupiter.label
      }`,
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
