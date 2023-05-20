import { parentPort, workerData } from 'worker_threads';
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
  CalculateQuoteParamPayload,
  DexLabel,
  GetSwapLegAndAccountsParamPayload,
  SerializableSwapLegAndAccounts,
  SerumMarketKeysString,
  UpdatePoolParamPayload,
} from './types.js';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { logger as loggerOrig } from '../logger.js';
import {
  toAccountInfo,
  toQuoteParams,
  toSerializableAccountMeta,
  toSerializableQuote,
  toSwapParams,
} from './utils.js';
import { QuoteParams, SwapParams } from '@jup-ag/core/dist/lib/amm.js';

const workerId = workerData.workerId;

const logger = loggerOrig.child({ name: 'calc-worker' + workerId });

logger.info('AmmCalcWorker started');

const pools: Map<string, Amm> = new Map();

function addPool(
  poolLabel: DexLabel,
  id: string,
  accountInfo: AccountInfo<Buffer>,
  serumParams?: SerumMarketKeysString,
) {
  let amm: Amm;
  logger.trace(`Adding pool ${id} with label ${poolLabel}`);
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
  logger.trace(`Updating pool ${id}`);
  const amm = pools.get(id);
  if (!amm) throw new Error(`Pool ${id} not found`);

  let message: AmmCalcWorkerResultMessage;

  try {
    amm.update(accountInfos);
    message = {
      type: 'updatePool',
      payload: {
        id,
      },
    };
  } catch (e) {
    message = {
      type: 'updatePool',
      payload: {
        id,
        error: e,
      },
    };
  }

  parentPort.postMessage(message);
}

function calulateQuote(id: string, params: QuoteParams) {
  logger.debug(`Calculating quote for pool ${id}`);
  const amm = pools.get(id);
  if (!amm) throw new Error(`Pool ${id} not found`);
  let message: AmmCalcWorkerResultMessage;

  try {
    const quote = amm.getQuote(params);
    const serializableQuote = toSerializableQuote(quote);

    message = {
      type: 'calculateQuote',
      payload: {
        quote: serializableQuote,
      },
    };
  } catch (e) {
    message = {
      type: 'calculateQuote',
      payload: {
        quote: null,
        error: e,
      },
    };
  }

  parentPort.postMessage(message);
}

function getSwapLegAndAccounts(id: string, params: SwapParams) {
  const amm = pools.get(id);
  if (!amm) throw new Error(`Pool ${id} not found`);

  const [legs, accounts] = amm.getSwapLegAndAccounts(params);
  const serializableSwapLegAndAccounts: SerializableSwapLegAndAccounts = [
    legs,
    accounts.map(toSerializableAccountMeta),
  ];

  const message: AmmCalcWorkerResultMessage = {
    type: 'getSwapLegAndAccounts',
    payload: {
      swapLegAndAccounts: serializableSwapLegAndAccounts,
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
    case 'calculateQuote': {
      const { id, params } = message.payload as CalculateQuoteParamPayload;
      const quoteParams = toQuoteParams(params);
      calulateQuote(id, quoteParams);
      break;
    }
    case 'getSwapLegAndAccounts': {
      const { id, params } =
        message.payload as GetSwapLegAndAccountsParamPayload;
      const swapParams = toSwapParams(params);
      getSwapLegAndAccounts(id, swapParams);
      break;
    }
  }
});
