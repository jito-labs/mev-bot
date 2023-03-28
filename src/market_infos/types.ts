import { Amm } from '@jup-ag/core';
import { PublicKey } from '@solana/web3.js';
import { logger } from '../logger.js';
import { toPairString } from './common.js';

export const BASE_MINTS_OF_INTEREST = {
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
};

export type BASE_MINT_OF_INTEREST = typeof BASE_MINTS_OF_INTEREST;

export type Market = {
  tokenMintA: PublicKey;
  tokenVaultA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultB: PublicKey;
  dex: DEX;
  jupiter: Amm;
};
export abstract class DEX {
  marketsByVault: Map<string, Market>;
  pairToMarkets: Map<string, Market[]>;
  updateHandlerInitPromises: Promise<void>[];
  label: string;

  constructor(label: string) {
    this.marketsByVault = new Map();
    this.pairToMarkets = new Map();
    this.updateHandlerInitPromises = [];
    this.label = label;
  }

  async initialize(): Promise<void> {
    await Promise.all(this.updateHandlerInitPromises);
    logger.info(`${this.label}: Initialized with: ${Array.from(this.pairToMarkets.values()).flat().length} pools`);
  }

  abstract getMarketTokenAccountsForTokenMint(
    tokenMint: PublicKey,
  ): PublicKey[];
  
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
}
