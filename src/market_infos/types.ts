import { Amm } from '@jup-ag/core';
import { PublicKey } from '@solana/web3.js';

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
  abstract initialize(): Promise<void>;
  abstract getMarketTokenAccountsForTokenMint(
    tokenMint: PublicKey,
  ): PublicKey[];
  abstract getMarketForVault(vault: PublicKey): Market;
  abstract getMarketsForPair(mintA: PublicKey, mintB: PublicKey): Market[];
}
