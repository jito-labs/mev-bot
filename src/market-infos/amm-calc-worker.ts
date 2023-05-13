import { parentPort } from 'worker_threads';
import {
  Amm,
  RaydiumAmm,
  RaydiumClmm,
  SplTokenSwapAmm,
  WhirlpoolAmm,
} from '@jup-ag/core';
import {
  AccountInfoMap,
  AddPoolParamPayload,
  AmmCalcWorkerParamMessage,
  AmmCalcWorkerResultMessage,
  DexLabel,
  SerumMarketKeysString,
  UpdatePoolParamPayload,
} from './types.js';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { logger } from '../logger.js';
import { toAccountInfo } from './utils.js';

logger.info('AmmCalcWorker started');

const pools: Map<string, Amm> = new Map();

function addPool(
  poolLabel: DexLabel,
  id: string,
  accountInfo: AccountInfo<Buffer>,
  serumParams?: SerumMarketKeysString,
) {
  let amm: Amm;
  logger.info(`Adding pool ${id} with label ${poolLabel}`);
  switch (poolLabel) {
    case DexLabel.ORCA:
      amm = new SplTokenSwapAmm(new PublicKey(id), accountInfo, 'Orca');
      break;
    case DexLabel.ORCA_WHIRLPOOLS:
      amm = new WhirlpoolAmm(new PublicKey(id), accountInfo);
      break;
    case DexLabel.RAYDIUM:
      if (!serumParams)
        throw new Error('Serum params not provided for raydium pool');
      amm = new RaydiumAmm(new PublicKey(id), accountInfo, serumParams);
      break;
    case DexLabel.RAYDIUM_CLMM:
      amm = new RaydiumClmm(new PublicKey(id), accountInfo);
      break;
    default:
      throw new Error(`Unknown pool label: ${poolLabel}`);
  }
  pools.set(id, amm);
  const accountsForUpdate = amm.getAccountsForUpdate().map((a) => a.toBase58());

  const message: AmmCalcWorkerResultMessage = {
    type: 'addPool',
    payload: {
      id,
      accountsForUpdate,
    },
  };
  parentPort.postMessage(message);
}

function updatePool(id: string, accountInfos: AccountInfoMap) {
  const amm = pools.get(id);
  if (!amm) throw new Error(`Pool ${id} not found`);

  amm.update(accountInfos);
  const message: AmmCalcWorkerResultMessage = {
    type: 'updatePool',
    payload: {
      id,
    },
  };
  parentPort.postMessage(message);
}

parentPort.on('message', (message: AmmCalcWorkerParamMessage) => {
  switch (message.type) {
    case 'addPool': {
      const { poolLabel, id, serializableAccountInfo, serumParams } =
        message.payload as AddPoolParamPayload;
      const accountInfo = toAccountInfo(serializableAccountInfo);
      addPool(poolLabel, id, accountInfo, serumParams);
      break;
    }
    case 'updatePool': {
      const { id, accountInfoMap } = message.payload as UpdatePoolParamPayload;
      const accountInfos = new Map();
      for (const [key, value] of accountInfoMap.entries()) {
        accountInfos.set(key, value === null ? null : toAccountInfo(value));
      }
      updatePool(id, accountInfos);
      break;
    }
    default:
      logger.error(`Unknown message type: ${message.type}`);
  }
});
