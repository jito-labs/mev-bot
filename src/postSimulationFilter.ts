import { PublicKey, SimulatedTransactionAccountInfo } from '@solana/web3.js';
import { logger } from './logger.js';
import { SimulationResult } from './simulation.js';
import * as Token from '@solana/spl-token';
type ArbOpportunity = {
  programId: string;
};

function unpackTokenAccount(pubkey: PublicKey, accountInfo: SimulatedTransactionAccountInfo): Token.Account {
  const data = Buffer.from(accountInfo.data[0], 'base64');
  const tokenAccountInfo = Token.unpackAccount(pubkey, {
    data,
    executable: accountInfo.executable,
    lamports: accountInfo.lamports,
    owner: new PublicKey(accountInfo.owner),
    rentEpoch: accountInfo.rentEpoch,
  })
  return tokenAccountInfo;
}

async function* postSimulateFilter(
  simulationsIterator: AsyncGenerator<SimulationResult>,
): AsyncGenerator<ArbOpportunity> {
  for await (const {response, accountsOfInterest} of simulationsIterator) {
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
      logger.info(`account ${pubkey.toString()} with mint ${preSimTokenAccount.mint} changed by ${diff} units`);
    }

    yield { programId: 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB' };
  }
}

export { postSimulateFilter };
