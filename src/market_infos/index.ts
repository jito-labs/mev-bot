import { PublicKey } from '@solana/web3.js';
import { DEX } from './dex.js';
import { OrcaWhirpoolDEX } from './orca_whirlpool/index.js';
import { RaydiumDEX } from './raydium/index.js';

const BASE_MINTS_OF_INTEREST = {
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
};

const dexs: DEX[] = [new RaydiumDEX(), new OrcaWhirpoolDEX()];

const tokenAccountsOfInterest = new Map<string, DEX>();

for (const dex of dexs) {
  const usdcTokenAccounts = dex.getMarketTokenAccountsForTokenMint(
    BASE_MINTS_OF_INTEREST.USDC,
  );
  const solTokenAccounts = dex.getMarketTokenAccountsForTokenMint(
    BASE_MINTS_OF_INTEREST.SOL,
  );
  const tokenAccounts = [...usdcTokenAccounts, ...solTokenAccounts];
  for (const tokenAccount of tokenAccounts) {
    tokenAccountsOfInterest.set(tokenAccount.toBase58(), dex);
  }
}

const isTokenAccountOfInterest = (tokenAccount: PublicKey): boolean => {
  return tokenAccountsOfInterest.has(tokenAccount.toBase58());
};

export { DEX, isTokenAccountOfInterest };
