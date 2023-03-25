import {
  PublicKey,
  SimulatedTransactionAccountInfo,
  VersionedTransaction,
} from '@solana/web3.js';
import { SimulationResult } from './simulation.js';
import * as Token from '@solana/spl-token-3';
import { Market } from './market_infos/types.js';
import { getMarketForVault } from './market_infos/index.js';
import { Timings } from './types.js';

type BackrunnableTrade = {
  txn: VersionedTransaction;
  market: Market;
  isVaultA: boolean;
  buyOnCurrentMarket: boolean
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
  for await (const {
    txn,
    response,
    accountsOfInterest,
    timings,
  } of simulationsIterator) {
    const txnSimulationResult = response.value.transactionResults[0];

    if (txnSimulationResult.err !== null) {
      continue;
    }

    for (let i = 0; i < accountsOfInterest.length; i++) {
      const pubkey = accountsOfInterest[i];
      const preSimState = txnSimulationResult.preExecutionAccounts[i];
      const postSimState = txnSimulationResult.postExecutionAccounts[i];

      const preSimTokenAccount = unpackTokenAccount(pubkey, preSimState);
      const postSimTokenAccount = unpackTokenAccount(pubkey, postSimState);

      const diff = postSimTokenAccount.amount - preSimTokenAccount.amount;
      const isNegative = diff < 0n;
      const diffAbs = isNegative ? -diff : diff;
      const { market, isVaultA } = getMarketForVault(pubkey);

      yield {
        txn,
        market,
        isVaultA,
        buyOnCurrentMarket: isNegative,
        tradeSize: diffAbs,
        timings: {
          mempoolEnd: timings.mempoolEnd,
          preSimEnd: timings.preSimEnd,
          simEnd: timings.simEnd,
          postSimEnd: Date.now(),
          calcArbEnd: 0,
        },
      };
    }
  }
}

export { postSimulateFilter, BackrunnableTrade };
