import { AccountInfo, PublicKey } from '@solana/web3.js';
import { connection } from '../clients/rpc.js';
import { AccountSubscriptionHandlersMap } from '../clients/geyser.js';
import { logger } from '../logger.js';
import {
  AccountInfoMap,
  SerializableAccountInfo,
  SerializableQuote,
  SerializableQuoteParams,
} from './types.js';
import { Quote, QuoteParams } from '@jup-ag/core/dist/lib/amm.js';
import jsbi from 'jsbi';
import { defaultImport } from 'default-import';
const JSBI = defaultImport(jsbi);

/**
 * Helper to init a set of accounts and if any of those changes callback with the whole set
 */
class GeyserMultipleAccountsUpdateHandler {
  isInitialized: boolean;
  resolveOnInitialized: Promise<void>;
  accountInfoMap: AccountInfoMap;
  callback: (accountInfos: AccountInfoMap) => void;
  addresses: PublicKey[];

  constructor(
    addresses: PublicKey[],
    callback: (accountInfos: AccountInfoMap) => void,
  ) {
    this.accountInfoMap = new Map();
    this.isInitialized = false;
    this.callback = callback;
    this.addresses = addresses;

    let resolve: () => void;
    this.resolveOnInitialized = new Promise((r) => {
      resolve = r;
    });

    connection.getMultipleAccountsInfo(addresses).then((accountInfos) => {
      for (let i = 0; i < accountInfos.length; i++) {
        this.accountInfoMap.set(addresses[i].toBase58(), accountInfos[i]);
      }
      this.isInitialized = true;
      resolve();
      callback(this.accountInfoMap);
    });
  }

  getUpdateHandlers(): AccountSubscriptionHandlersMap {
    const geyserSubscriptions: AccountSubscriptionHandlersMap = new Map();

    for (const address of this.addresses) {
      const handler = (accountInfo: AccountInfo<Buffer> | null) => {
        this.accountInfoMap.set(address.toBase58(), accountInfo);
        if (this.isInitialized) {
          logger.trace(`Geyser AMM account update: ${address.toBase58()}`);
          try {
            this.callback(this.accountInfoMap);
          } catch (e) {
            logger.error(
              e,
              `Geyser AMM update failed for ${address.toBase58()}`,
            );
          }
        }
      };
      if (geyserSubscriptions.has(address.toBase58())) {
        geyserSubscriptions.get(address.toBase58()).push(handler);
      } else {
        geyserSubscriptions.set(address.toBase58(), [handler]);
      }
    }

    return geyserSubscriptions;
  }

  async waitForInitialized() {
    await this.resolveOnInitialized;
  }
}

function toPairString(mintA: PublicKey, mintB: PublicKey): string {
  if (mintA.toBase58() < mintB.toBase58()) {
    return `${mintA.toBase58()}-${mintB.toBase58()}`;
  } else {
    return `${mintB.toBase58()}-${mintA.toBase58()}`;
  }
}

function toSerializableAccountInfo(
  accountInfo: AccountInfo<Buffer>,
): SerializableAccountInfo {
  return {
    data: new Uint8Array(accountInfo.data),
    executable: accountInfo.executable,
    lamports: accountInfo.lamports,
    owner: accountInfo.owner.toBase58(),
    rentEpoch: accountInfo.rentEpoch,
  };
}

function toAccountInfo(
  accountInfo: SerializableAccountInfo,
): AccountInfo<Buffer> {
  return {
    data: Buffer.from(accountInfo.data),
    executable: accountInfo.executable,
    lamports: accountInfo.lamports,
    owner: new PublicKey(accountInfo.owner),
    rentEpoch: accountInfo.rentEpoch,
  };
}

function toSerializableQuote(quote: Quote): SerializableQuote {
  return {
    notEnoughLiquidity: quote.notEnoughLiquidity,
    minInAmount: quote.minInAmount?.toString(),
    minOutAmount: quote.minOutAmount?.toString(),
    inAmount: quote.inAmount.toString(),
    outAmount: quote.outAmount.toString(),
    feeAmount: quote.feeAmount.toString(),
    feeMint: quote.feeMint,
    feePct: quote.feePct,
    priceImpactPct: quote.priceImpactPct,
  };
}

function toQuote(serializableQuote: SerializableQuote): Quote {
  return {
    notEnoughLiquidity: serializableQuote.notEnoughLiquidity,
    minInAmount: serializableQuote.minInAmount
      ? JSBI.BigInt(serializableQuote.minInAmount)
      : undefined,
    minOutAmount: serializableQuote.minOutAmount
      ? JSBI.BigInt(serializableQuote.minOutAmount)
      : undefined,
    inAmount: JSBI.BigInt(serializableQuote.inAmount),
    outAmount: JSBI.BigInt(serializableQuote.outAmount),
    feeAmount: JSBI.BigInt(serializableQuote.feeAmount),
    feeMint: serializableQuote.feeMint,
    feePct: serializableQuote.feePct,
    priceImpactPct: serializableQuote.priceImpactPct,
  };
}

function toSerializableQuoteParams(
  quoteParams: QuoteParams,
): SerializableQuoteParams {
  return {
    sourceMint: quoteParams.sourceMint.toBase58(),
    destinationMint: quoteParams.destinationMint.toBase58(),
    amount: quoteParams.amount.toString(),
    swapMode: quoteParams.swapMode,
  };
}

function toQuoteParams(
  serializableQuoteParams: SerializableQuoteParams,
): QuoteParams {
  return {
    sourceMint: new PublicKey(serializableQuoteParams.sourceMint),
    destinationMint: new PublicKey(serializableQuoteParams.destinationMint),
    amount: JSBI.BigInt(serializableQuoteParams.amount),
    swapMode: serializableQuoteParams.swapMode,
  };
}

export {
  GeyserMultipleAccountsUpdateHandler,
  toPairString,
  toSerializableAccountInfo,
  toAccountInfo,
  toSerializableQuote,
  toQuote,
  toSerializableQuoteParams,
  toQuoteParams,
};
