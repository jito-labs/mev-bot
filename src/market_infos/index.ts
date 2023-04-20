import { PublicKey } from '@solana/web3.js';
import { DEX, BASE_MINTS_OF_INTEREST, Market } from './types.js';
import { OrcaWhirpoolDEX } from './orca_whirlpool/index.js';
import { RaydiumDEX } from './raydium/index.js';
import { RaydiumClmmDEX } from './raydium_clmm/index.js';
import { OrcaDEX } from './orca/index.js';

const dexs: DEX[] = [new RaydiumDEX(), new OrcaWhirpoolDEX(), new RaydiumClmmDEX(), new OrcaDEX()];

for (const dex of dexs) {
  await dex.initialize();
}

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

const getMarketForVault = (
  vault: PublicKey,
): { market: Market; isVaultA: boolean } => {
  const dex = tokenAccountsOfInterest.get(vault.toBase58());
  if (dex === undefined) {
    throw new Error('Vault not found');
  }
  const market = dex.getMarketForVault(vault);
  if (market === undefined) {
    throw new Error('Market not found');
  }

  return { market, isVaultA: market.tokenVaultA.equals(vault) };
};

const getMarketsForPair = (mintA: PublicKey, mintB: PublicKey): Market[] => {
  const markets: Market[] = [];
  for (const dex of dexs) {
    markets.push(...dex.getMarketsForPair(mintA, mintB));
  }
  return markets;
};

export { DEX, isTokenAccountOfInterest, getMarketForVault, getMarketsForPair };
