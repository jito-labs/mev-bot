import { AccountInfo, PublicKey } from '@solana/web3.js';
import { toPairString } from './utils.js';
import { BASE_MINTS_OF_INTEREST } from '../constants.js';

export type BASE_MINT_OF_INTEREST = typeof BASE_MINTS_OF_INTEREST;

export enum DexLabel {
  ORCA = 'Orca',
  ORCA_WHIRLPOOLS = 'Orca (Whirlpools)',
  RAYDIUM = 'Raydium',
  RAYDIUM_CLMM = 'Raydium CLMM',
}

export type Market = {
  tokenMintA: PublicKey;
  tokenVaultA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultB: PublicKey;
  dexLabel: DexLabel;
  id: string;
};

export abstract class DEX {
  marketsByVault: Map<string, Market>;
  pairToMarkets: Map<string, Market[]>;
  ammCalcAddPoolMessages: AmmCalcWorkerParamMessage[];
  label: DexLabel;

  constructor(label: DexLabel) {
    this.marketsByVault = new Map();
    this.pairToMarkets = new Map();
    this.ammCalcAddPoolMessages = [];
    this.label = label;
  }

  abstract getMarketTokenAccountsForTokenMint(
    tokenMint: PublicKey,
  ): PublicKey[];

  getAmmCalcAddPoolMessages(): AmmCalcWorkerParamMessage[] {
    return this.ammCalcAddPoolMessages;
  }

  getMarketForVault(vault: PublicKey): Market {
    const market = this.marketsByVault.get(vault.toBase58());
    if (market === undefined) {
      throw new Error('Vault not found');
    }
    return market;
  }

  getMarketsForPair(mintA: PublicKey, mintB: PublicKey): Market[] {
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
export type SerializableAccountInfoMap = Map<string, SerializableAccountInfo | null>;

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
  serializableAccountInfo: SerializableAccountInfo;
  serumParams?: SerumMarketKeysString;
};

export type AddPoolResultPayload = {
  id: string;
  accountsForUpdate: string[];
};

export type UpdatePoolParamPayload = {
  id: string;
  accountInfoMap: SerializableAccountInfoMap;
};

export type UpdatePoolResultPayload = {
  id: string;
};

export type AmmCalcWorkerParamMessage = {
  type: 'addPool' | 'updatePool';
  payload: AddPoolParamPayload | UpdatePoolParamPayload;
};

export type AmmCalcWorkerResultMessage = {
  type: 'addPool' | 'updatePool';
  payload: AddPoolResultPayload | UpdatePoolResultPayload;
};

export type SerializableAccountInfo = {
  executable: boolean;
  owner: string;
  lamports: number;
  data: Uint8Array;
  rentEpoch?: number;
};
