import {
  RpcResponseAndContext,
} from '@solana/web3.js';
import { SimulatedBundleResponse } from 'jito-ts';
import { logger } from './logger.js';

type ArbOpportunity = {
  programId: string;
};

async function* postSimulateFilter(
  simulationsIterator: AsyncGenerator<
    RpcResponseAndContext<SimulatedBundleResponse>
  >,
): AsyncGenerator<ArbOpportunity> {
  for await (const simulation of simulationsIterator) {
    const simulationResponse = simulation.value;

    if (simulationResponse.transactionResults[0].err !== null) {
      continue;
    }

    logger.warn(`have opp for ${simulationResponse.toString()}`);

    yield { programId: 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB' };
  }
}

export { postSimulateFilter };