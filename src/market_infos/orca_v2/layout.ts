import * as BufferLayout from '@solana/buffer-layout';
import { publicKey, u64 } from '@solana/buffer-layout-utils';

export const TokenSwapLayout = BufferLayout.struct([
  BufferLayout.u8('version'),
  BufferLayout.u8('isInitialized'),
  BufferLayout.u8('bumpSeed'),
  publicKey('poolTokenProgramId'),
  publicKey('tokenAccountA'),
  publicKey('tokenAccountB'),
  publicKey('tokenPool'),
  publicKey('mintA'),
  publicKey('mintB'),
  publicKey('feeAccount'),
  u64('tradeFeeNumerator'),
  u64('tradeFeeDenominator'),
  u64('ownerTradeFeeNumerator'),
  u64('ownerTradeFeeDenominator'),
  u64('ownerWithdrawFeeNumerator'),
  u64('ownerWithdrawFeeDenominator'),
  u64('hostFeeNumerator'),
  u64('hostFeeDenominator'),
  BufferLayout.u8('curveType'),
  BufferLayout.blob(32, 'curveParameters'),
]);
