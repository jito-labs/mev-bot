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
  tradeSize: bigint;
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

    for (let i = 0; i < accountsOfInterest.length; i++) {
      // the accounts of interest are usdc/ solana vaults of dex markets
      const vaultOfInterestStr = accountsOfInterest[i];
      const vaultOfInterest = new PublicKey(vaultOfInterestStr);
      const preSimState = txnSimulationResult.preExecutionAccounts[i];
      const postSimState = txnSimulationResult.postExecutionAccounts[i];

      const preSimTokenAccount = unpackTokenAccount(
        vaultOfInterest,
        preSimState,
      );
      const postSimTokenAccount = unpackTokenAccount(
        vaultOfInterest,
        postSimState,
      );

      // positive if balance increased
      const diff = postSimTokenAccount.amount - preSimTokenAccount.amount;
      const isNegative = diff < 0n;
      const diffAbs = isNegative ? -diff : diff;

      if (diffAbs === 0n) {
        continue;
      }

      const { market, isVaultA } = getMarketForVault(vaultOfInterestStr);

      yield {
        txn,
        market,
        baseIsTokenA: isVaultA,
        tradeDirection: isNegative
          ? TradeDirection.BOUGHT_BASE
          : TradeDirection.SOLD_BASE,
        tradeSize: diffAbs,
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
