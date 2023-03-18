import { PublicKey } from "@solana/web3.js";

abstract class DEX {
  abstract getMarketTokenAccountsForTokenMint(
    tokenMint: PublicKey,
  ): PublicKey[];
}

export { DEX };
