import {
  PublicKey,
  SimulatedTransactionAccountInfo,
  VersionedTransaction,
} from '@solana/web3.js';
import { SimulationResult } from './simulation.js';
import * as Token from '@solana/spl-token-3';
import { Market } from './markets/types.js';
import { getMarketForVault } from './markets/index.js';
import { Timings } from './types.js';
import { dropBeyondHighWaterMark } from './utils.js';
import { BASE_MINTS_OF_INTEREST_B58 } from './constants.js';
import { logger } from './logger.js';
import bs58 from 'bs58';

const HIGH_WATER_MARK = 100;

enum TradeDirection {
  SOLD_BASE = 'SOLD_BASE',
  BOUGHT_BASE = 'BOUGHT_BASE',
}

type BackrunnableTrade = {
  txn: VersionedTransaction;
  market: Market;
  baseIsTokenA: boolean;
  tradeDirection: TradeDirection;
  tradeSizeA: bigint;
  tradeSizeB: bigint;
  timings: Timings;
};

function unpackTokenAccount(
  pubkey: PublicKey,
  accountInfo: SimulatedTransactionAccountInfo,
): Token.Account {
  const data = Buffer.from(accountInfo.data[0], 'base64');
  const tokenAccountInfo = Token.unpackAccount(pubkey, {
    data,
    executable: accountInfo.executable,
    lamports: accountInfo.lamports,
    owner: new PublicKey(accountInfo.owner),
    rentEpoch: accountInfo.rentEpoch,
  });
  return tokenAccountInfo;
}

async function* postSimulateFilter(
  simulationsIterator: AsyncGenerator<SimulationResult>,
): AsyncGenerator<BackrunnableTrade> {
  const simulationsIteratorGreedy = dropBeyondHighWaterMark(
    simulationsIterator,
    HIGH_WATER_MARK,
    'simulationsIterator',
  );

  for await (const {
    txn,
    response,
    accountsOfInterest,
    timings,
  } of simulationsIteratorGreedy) {
    const txnSimulationResult = response.value.transactionResults[0];

    if (txnSimulationResult.err !== null) {
      continue;
    }

    const markets = new Set<Market>();
    const preSimTokenAccounts = new Map<string, Token.Account>();
    const postSimTokenAccounts = new Map<string, Token.Account>();

    for (let i = 0; i < accountsOfInterest.length; i++) {
      const accountOfInterest = accountsOfInterest[i];
      const preSimState = txnSimulationResult.preExecutionAccounts[i];
      const postSimState = txnSimulationResult.postExecutionAccounts[i];

      const preSimTokenAccount = unpackTokenAccount(
        new PublicKey(accountOfInterest),
        preSimState,
      );
      const postSimTokenAccount = unpackTokenAccount(
        new PublicKey(accountOfInterest),
        postSimState,
      );

      preSimTokenAccounts.set(accountOfInterest, preSimTokenAccount);
      postSimTokenAccounts.set(accountOfInterest, postSimTokenAccount);

      const market = getMarketForVault(accountOfInterest);
      markets.add(market);
    }

    for (const market of markets) {
      const preSimTokenAccountVaultA = preSimTokenAccounts.get(
        market.tokenVaultA,
      );
      const postSimTokenAccountVaultA = postSimTokenAccounts.get(
        market.tokenVaultA,
      );
      const preSimTokenAccountVaultB = preSimTokenAccounts.get(
        market.tokenVaultB,
      );
      const postSimTokenAccountVaultB = postSimTokenAccounts.get(
        market.tokenVaultB,
      );

      const tokenAIsBase =
        market.tokenMintA === BASE_MINTS_OF_INTEREST_B58.SOL ||
        market.tokenMintA === BASE_MINTS_OF_INTEREST_B58.USDC;

      const tokenADiff =
        postSimTokenAccountVaultA.amount - preSimTokenAccountVaultA.amount;
      const tokenAIsNegative = tokenADiff < 0n;
      const tokenADiffAbs = tokenAIsNegative ? -tokenADiff : tokenADiff;

      const tokenBDiff =
        postSimTokenAccountVaultB.amount - preSimTokenAccountVaultB.amount;
      const tokenBIsNegative = tokenBDiff < 0n;
      const tokenBDiffAbs = tokenBIsNegative ? -tokenBDiff : tokenBDiff;

      const didNotChangeVaults = tokenADiffAbs === 0n || tokenBDiffAbs === 0n;
      const addOrRemoveLiq = tokenAIsNegative === tokenBIsNegative;
      if (didNotChangeVaults || addOrRemoveLiq) {
        continue;
      }

      logger.debug(
        `${market.dexLabel} ${bs58.encode(txn.signatures[0])} \n${
          market.tokenMintA
        } ${postSimTokenAccountVaultA.amount} - ${
          preSimTokenAccountVaultA.amount
        } = ${tokenADiff} \n${market.tokenMintB} ${
          postSimTokenAccountVaultB.amount
        } - ${preSimTokenAccountVaultB.amount} = ${tokenBDiff}`,
      );

      const isBaseNegative = tokenAIsBase ? tokenAIsNegative : tokenBIsNegative;

      yield {
        txn,
        market,
        baseIsTokenA: tokenAIsBase,
        tradeDirection: isBaseNegative
          ? TradeDirection.BOUGHT_BASE
          : TradeDirection.SOLD_BASE,
        tradeSizeA: tokenADiffAbs,
        tradeSizeB: tokenBDiffAbs,
        timings: {
          mempoolEnd: timings.mempoolEnd,
          preSimEnd: timings.preSimEnd,
          simEnd: timings.simEnd,
          postSimEnd: Date.now(),
          calcArbEnd: 0,
          buildBundleEnd: 0,
          bundleSent: 0,
        },
      };
    }
  }
}

export { postSimulateFilter, BackrunnableTrade };
