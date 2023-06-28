import { AccountInfo, PublicKey } from '@solana/web3.js';
import { toPairString } from './utils.js';
import { BASE_MINTS_OF_INTEREST } from '../constants.js';
import { SwapLegType } from '@jup-ag/core/dist/lib/jupiterEnums.js';
import jsbi from 'jsbi';

export type BASE_MINT_OF_INTEREST = typeof BASE_MINTS_OF_INTEREST;

export enum DexLabel {
  ORCA = 'Orca',
  ORCA_WHIRLPOOLS = 'Orca (Whirlpools)',
  RAYDIUM = 'Raydium',
  RAYDIUM_CLMM = 'Raydium CLMM',
}

export type Market = {
  tokenMintA: string;
  tokenVaultA: string;
  tokenMintB: string;
  tokenVaultB: string;
  dexLabel: DexLabel;
  id: string;
};

export abstract class DEX {
  pairToMarkets: Map<string, Market[]>;
  ammCalcAddPoolMessages: AmmCalcWorkerParamMessage[];
  label: DexLabel;

  constructor(label: DexLabel) {
    this.pairToMarkets = new Map();
    this.ammCalcAddPoolMessages = [];
    this.label = label;
  }

  getAmmCalcAddPoolMessages(): AmmCalcWorkerParamMessage[] {
    return this.ammCalcAddPoolMessages;
  }

  getMarketsForPair(mintA: string, mintB: string): Market[] {
    const markets = this.pairToMarkets.get(toPairString(mintA, mintB));
    if (markets === undefined) {
      return [];
    }
    return markets;
  }

  getAllMarkets(): Market[] {
    return Array.from(this.pairToMarkets.values()).flat();
  }
}

export type AccountInfoMap = Map<string, AccountInfo<Buffer> | null>;
export type SerializableAccountInfoMap = Map<
  string,
  SerializableAccountInfo | null
>;

type SerumMarketKeys = {
  serumBids: PublicKey;
  serumAsks: PublicKey;
  serumEventQueue: PublicKey;
  serumCoinVaultAccount: PublicKey;
  serumPcVaultAccount: PublicKey;
  serumVaultSigner: PublicKey;
};

export type SerumMarketKeysString = Record<keyof SerumMarketKeys, string>;

export type AddPoolParamPayload = {
  poolLabel: DexLabel;
  id: string;
  feeRateBps: number;
  serializableAccountInfo: SerializableAccountInfo;
  serumParams?: SerumMarketKeysString;
};

export type AddPoolResultPayload = {
  id: string;
  accountsForUpdate: string[];
};

export type AccountUpdateParamPayload = {
  id: string;
  accountInfo: SerializableAccountInfo;
};

export type AccountUpdateResultPayload = {
  id: string;
  error: boolean;
};

export type CalculateQuoteParamPayload = {
  id: string;
  params: SerializableQuoteParams;
};

export type CalculateQuoteResultPayload = {
  quote: SerializableJupiterQuote | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: any;
};

export type GetSwapLegAndAccountsParamPayload = {
  id: string;
  params: SerializableSwapParams;
};

export type GetSwapLegAndAccountsResultPayload = {
  swapLegAndAccounts: SerializableSwapLegAndAccounts;
};

export type CalculateRouteParamPayload = {
  route: SerializableRoute;
};

export type CalculateRouteResultPayload = {
  quote: SerializableQuote;
};

export type AmmCalcWorkerParamMessage =
  | {
      type: 'addPool';
      payload: AddPoolParamPayload;
    }
  | {
      type: 'accountUpdate';
      payload: AccountUpdateParamPayload;
    }
  | {
      type: 'calculateQuote';
      payload: CalculateQuoteParamPayload;
    }
  | {
      type: 'getSwapLegAndAccounts';
      payload: GetSwapLegAndAccountsParamPayload;
    }
  | {
      type: 'calculateRoute';
      payload: CalculateRouteParamPayload;
    };

export type AmmCalcWorkerResultMessage =
  | {
      type: 'addPool';
      payload: AddPoolResultPayload;
    }
  | {
      type: 'accountUpdate';
      payload: AccountUpdateResultPayload;
    }
  | {
      type: 'calculateQuote';
      payload: CalculateQuoteResultPayload;
    }
  | {
      type: 'getSwapLegAndAccounts';
      payload: GetSwapLegAndAccountsResultPayload;
    }
  | {
      type: 'calculateRoute';
      payload: CalculateRouteResultPayload;
    };

export type SerializableAccountInfo = {
  executable: boolean;
  owner: string;
  lamports: number;
  data: Uint8Array;
  rentEpoch?: number;
};

export type SerializableJupiterQuote = {
  notEnoughLiquidity: boolean;
  minInAmount?: string;
  minOutAmount?: string;
  inAmount: string;
  outAmount: string;
  feeAmount: string;
  feeMint: string;
  feePct: number;
  priceImpactPct: number;
};

export enum SwapMode {
  ExactIn = 'ExactIn',
  ExactOut = 'ExactOut',
}

export type SerializableQuoteParams = {
  sourceMint: string;
  destinationMint: string;
  amount: string;
  swapMode: SwapMode;
};

export type SerializableSwapParams = {
  sourceMint: string;
  destinationMint: string;
  userSourceTokenAccount: string;
  userDestinationTokenAccount: string;
  userTransferAuthority: string;
  amount: string;
  swapMode: SwapMode;
};

export type SerializableSwapLegAndAccounts = [
  SwapLegType,
  SerializableAccountMeta[],
];

export type SerializableAccountMeta = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type SerializableRoute = {
  sourceMint: string;
  destinationMint: string;
  amount: string;
  marketId: string;
  tradeOutputOverride: null | {
    in: string;
    estimatedOut: string;
  }
}[];

export type Quote = { in: jsbi.default; out: jsbi.default };
export type SerializableQuote = {
  in: string;
  out: string;
};
