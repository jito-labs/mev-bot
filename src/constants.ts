import { PublicKey } from '@solana/web3.js';

export const BASE_MINTS_OF_INTEREST = {
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
};

export const USDC_MINT_STRING = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

// solend constants from here https://api.solend.fi/v1/config?deployment=production
export const SOLEND_TURBO_POOL = new PublicKey(
  '7RCz8wb6WXxUhAigok9ttgrVgDFFFbibcirECzWSBauM',
);

export const SOLEND_TURBO_SOL_RESERVE = new PublicKey(
  'UTABCRXirrbpCNDogCoqEECtM3V44jXGCsK23ZepV3Z',
);
export const SOLEND_TURBO_SOL_LIQUIDITY = new PublicKey(
  '5cSfC32xBUYqGfkURLGfANuK64naHmMp27jUT7LQSujY',
);
export const SOLEND_TURBO_SOL_FEE_RECEIVER = new PublicKey(
  '5wo1tFpi4HaVKnemqaXeQnBEpezrJXcXvuztYaPhvgC7',
);

export const SOLEND_TURBO_USDC_RESERVE = new PublicKey(
  'EjUgEaPpKMg2nqex9obb46gZQ6Ar9mWSdVKbw9A6PyXA',
);
export const SOLEND_TURBO_USDC_LIQUIDITY = new PublicKey(
  '49mYvAcRHFYnHt3guRPsxecFqBAY8frkGSFuXRL3cqfC',
);
export const SOLEND_TURBO_USDC_FEE_RECEIVER = new PublicKey(
  '5Gdxn4yquneifE6uk9tK8X4CqHfWKjW2BvYU25hAykwP',
);

export const SOLEND_FLASHLOAN_FEE_BPS = 30;
