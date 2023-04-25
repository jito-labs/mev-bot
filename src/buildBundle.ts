import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { ArbIdea } from './calculateArb.js';
import * as fs from 'fs';
import { config } from './config.js';
import * as Token from '@solana/spl-token-3';
import { connection } from './connection.js';
import { BASE_MINTS_OF_INTEREST } from './market_infos/types.js';
import { BN } from 'bn.js';
import { IDL, JUPITER_PROGRAM_ID, SwapMode } from '@jup-ag/common';

import jsbi from 'jsbi';
import { defaultImport } from 'default-import';
import * as anchor from '@coral-xyz/anchor';
import { logger } from './logger.js';
import { Timings } from './types.js';
import { getMarketsForPair } from './market_infos/index.js';
import { lookupTableProvider } from './lookupTableProvider.js';
import {
  SOLEND_PRODUCTION_PROGRAM_ID,
  flashBorrowReserveLiquidityInstruction,
  flashRepayReserveLiquidityInstruction,
} from '@solendprotocol/solend-sdk';
const JSBI = defaultImport(jsbi);

// solend constants from here https://api.solend.fi/v1/config?deployment=production
const SOLEND_TURBO_POOL = new PublicKey(
  '7RCz8wb6WXxUhAigok9ttgrVgDFFFbibcirECzWSBauM',
);

const SOLEND_TURBO_SOL_RESERVE = new PublicKey(
  'UTABCRXirrbpCNDogCoqEECtM3V44jXGCsK23ZepV3Z',
);
const SOLEND_TURBO_SOL_LIQUIDITY = new PublicKey(
  '5cSfC32xBUYqGfkURLGfANuK64naHmMp27jUT7LQSujY',
);
const SOLEND_TURBO_SOL_FEE_RECEIVER = new PublicKey(
  '5wo1tFpi4HaVKnemqaXeQnBEpezrJXcXvuztYaPhvgC7',
);

const SOLEND_TURBO_USDC_RESERVE = new PublicKey(
  'EjUgEaPpKMg2nqex9obb46gZQ6Ar9mWSdVKbw9A6PyXA',
);
const SOLEND_TURBO_USDC_LIQUIDITY = new PublicKey(
  '49mYvAcRHFYnHt3guRPsxecFqBAY8frkGSFuXRL3cqfC',
);
const SOLEND_TURBO_USDC_FEE_RECEIVER = new PublicKey(
  '5Gdxn4yquneifE6uk9tK8X4CqHfWKjW2BvYU25hAykwP',
);

const SOLEND_FLASHLOAN_FEE_BPS = 30;

const PROFIT_BUFFER_PERCENT = 3;

const TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map((pubkey) => new PublicKey(pubkey));

const getRandomTipAccount = () =>
  TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];

const MIN_TIP_LAMPORTS = config.get('min_tip_lamports');
const TIP_PERCENT = config.get('tip_percent');

// 2 tx/ three signatrues
const TXN_FEES_LAMPORTS = 15000;

const minProfit = MIN_TIP_LAMPORTS + TXN_FEES_LAMPORTS;

const MIN_BALANCE_RENT_EXEMPT_TOKEN_ACC =
  await Token.getMinimumBalanceForRentExemptAccount(connection);

const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(fs.readFileSync(config.get('payer_keypair_path'), 'utf-8')),
  ),
);

const wallet = new anchor.Wallet(payer);
const provider = new anchor.AnchorProvider(connection, wallet, {});
const jupiterProgram = new anchor.Program(IDL, JUPITER_PROGRAM_ID, provider);

// market to calculate usdc profit in sol
const usdcToSolMkt = getMarketsForPair(
  BASE_MINTS_OF_INTEREST.SOL,
  BASE_MINTS_OF_INTEREST.USDC,
).filter(
  (market) =>
    // hardcode market to orca 0.05% fee SOL/USDC
    market.jupiter.id === '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm',
)[0];

if (!usdcToSolMkt) {
  throw new Error('No USDC/SOL market found');
}

const USDC_ATA = await Token.getOrCreateAssociatedTokenAccount(
  connection,
  payer,
  BASE_MINTS_OF_INTEREST.USDC,
  payer.publicKey,
);

type Arb = {
  bundle: VersionedTransaction[];
  arbSize: jsbi.default;
  expectedProfit: jsbi.default;
  hop1Dex: string;
  hop2Dex: string;
  sourceMint: PublicKey;
  intermediateMint: PublicKey;
  tipLamports: jsbi.default;
  timings: Timings;
};

async function* buildBundle(
  arbIdeaIterator: AsyncGenerator<ArbIdea>,
): AsyncGenerator<Arb> {
  for await (const {
    txn,
    arbSize,
    expectedProfit,
    hop1Market,
    hop2Market,
    sourceMint,
    intermediateMint,
    timings,
  } of arbIdeaIterator) {
    const isUSDC = sourceMint.equals(BASE_MINTS_OF_INTEREST.USDC);

    const flashloanFee = JSBI.divide(
      JSBI.multiply(arbSize, JSBI.BigInt(SOLEND_FLASHLOAN_FEE_BPS)),
      JSBI.BigInt(10000),
    );

    const expectedProfitMinusFee = JSBI.subtract(expectedProfit, flashloanFee);

    let expectedProfitLamports: jsbi.default;

    if (isUSDC) {
      expectedProfitLamports = usdcToSolMkt.jupiter.getQuote({
        sourceMint: BASE_MINTS_OF_INTEREST.USDC,
        destinationMint: BASE_MINTS_OF_INTEREST.SOL,
        amount: expectedProfitMinusFee,
        swapMode: SwapMode.ExactIn,
      }).outAmount;
    } else {
      expectedProfitLamports = expectedProfitMinusFee;
    }

    if (JSBI.lessThan(expectedProfitLamports, JSBI.BigInt(minProfit))) {
      logger.info(
        `Skipping due to profit (${expectedProfitLamports}) being less than min tip (${minProfit})`,
      );
      continue;
    }

    const tip = JSBI.divide(
      JSBI.multiply(expectedProfitMinusFee, JSBI.BigInt(TIP_PERCENT)),
      JSBI.BigInt(100),
    );

    const profitBuffer = JSBI.divide(
      JSBI.multiply(expectedProfitMinusFee, JSBI.BigInt(PROFIT_BUFFER_PERCENT)),
      JSBI.BigInt(100),
    );

    const tipLamports = JSBI.divide(
      JSBI.multiply(expectedProfitLamports, JSBI.BigInt(TIP_PERCENT)),
      JSBI.BigInt(100),
    );

    // arb size + tip + flashloan fee + profit buffer
    const minOut = JSBI.add(
      JSBI.add(arbSize, tip),
      JSBI.add(flashloanFee, profitBuffer),
    );

    const setUpIxns: TransactionInstruction[] = [];
    const setUpSigners: Keypair[] = [payer];

    let sourceTokenAccount: PublicKey;

    if (!isUSDC) {
      const sourceTokenAccountKeypair = Keypair.generate();
      setUpSigners.push(sourceTokenAccountKeypair);

      sourceTokenAccount = sourceTokenAccountKeypair.publicKey;

      const createSourceTokenAccountIxn = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: sourceTokenAccount,
        space: Token.ACCOUNT_SIZE,
        lamports: MIN_BALANCE_RENT_EXEMPT_TOKEN_ACC,
        programId: Token.TOKEN_PROGRAM_ID,
      });
      setUpIxns.push(createSourceTokenAccountIxn);

      const initSourceTokenAccountIxn =
        Token.createInitializeAccountInstruction(
          sourceTokenAccount,
          sourceMint,
          payer.publicKey,
        );
      setUpIxns.push(initSourceTokenAccountIxn);
    } else {
      sourceTokenAccount = USDC_ATA.address;
    }

    const intermediateTokenAccount = Token.getAssociatedTokenAddressSync(
      intermediateMint,
      payer.publicKey,
    );

    const createIntermediateTokenAccountIxn =
      Token.createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        intermediateTokenAccount,
        payer.publicKey,
        intermediateMint,
      );
    setUpIxns.push(createIntermediateTokenAccountIxn);

    const [hop1Leg, hop1Accounts] = hop1Market.jupiter.getSwapLegAndAccounts({
      sourceMint: sourceMint,
      destinationMint: intermediateMint,
      userSourceTokenAccount: sourceTokenAccount,
      userDestinationTokenAccount: intermediateTokenAccount,
      userTransferAuthority: payer.publicKey,
      amount: arbSize,
      swapMode: SwapMode.ExactIn,
    });

    const [hop2Leg, hop2Accounts] = hop2Market.jupiter.getSwapLegAndAccounts({
      sourceMint: intermediateMint,
      destinationMint: sourceMint,
      userSourceTokenAccount: intermediateTokenAccount,
      userDestinationTokenAccount: sourceTokenAccount,
      userTransferAuthority: payer.publicKey,
      amount: JSBI.BigInt(1),
      swapMode: SwapMode.ExactIn,
    });

    const legs = {
      chain: {
        swapLegs: [hop1Leg, hop2Leg],
      },
    };

    const instructionsMain: TransactionInstruction[] = [];

    const solendReserve = isUSDC
      ? SOLEND_TURBO_USDC_RESERVE
      : SOLEND_TURBO_SOL_RESERVE;

    const solendLiquidity = isUSDC
      ? SOLEND_TURBO_USDC_LIQUIDITY
      : SOLEND_TURBO_SOL_LIQUIDITY;

    const flashBorrowIxn = flashBorrowReserveLiquidityInstruction(
      new BN(arbSize.toString()),
      solendLiquidity,
      sourceTokenAccount,
      solendReserve,
      SOLEND_TURBO_POOL,
      SOLEND_PRODUCTION_PROGRAM_ID,
    );

    instructionsMain.push(flashBorrowIxn);

    const jupiterIxn = jupiterProgram.instruction.route(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      legs as any,
      new BN(arbSize.toString()),
      new BN(minOut.toString()),
      0,
      0,
      {
        accounts: {
          tokenProgram: Token.TOKEN_PROGRAM_ID,
          userTransferAuthority: payer.publicKey,
          destinationTokenAccount: sourceTokenAccount,
        },
        remainingAccounts: [...hop1Accounts, ...hop2Accounts],
        signers: [payer],
      },
    );

    instructionsMain.push(jupiterIxn);

    const solendFeeReceiver = isUSDC
      ? SOLEND_TURBO_USDC_FEE_RECEIVER
      : SOLEND_TURBO_SOL_FEE_RECEIVER;

    const flashRepayIxn = flashRepayReserveLiquidityInstruction(
      new BN(arbSize.toString()), // liquidityAmount
      0, // borrowInstructionIndex
      sourceTokenAccount, // sourceLiquidity
      solendLiquidity, // destinationLiquidity
      solendFeeReceiver, // reserveLiquidityFeeReceiver
      sourceTokenAccount, // hostFeeReceiver
      solendReserve, // reserve
      SOLEND_TURBO_POOL, // lendingMarket
      payer.publicKey, // userTransferAuthority
      SOLEND_PRODUCTION_PROGRAM_ID, // lendingProgramId
    );

    instructionsMain.push(flashRepayIxn);

    if (!isUSDC) {
      const closeSolTokenAcc = Token.createCloseAccountInstruction(
        sourceTokenAccount,
        payer.publicKey,
        payer.publicKey,
      );
      instructionsMain.push(closeSolTokenAcc);
    }

    const tipIxn = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: getRandomTipAccount(),
      lamports: BigInt(tipLamports.toString()),
    });
    instructionsMain.push(tipIxn);

    const messageSetUp = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: txn.message.recentBlockhash,
      instructions: setUpIxns,
    }).compileToV0Message();
    const txSetUp = new VersionedTransaction(messageSetUp);
    txSetUp.sign(setUpSigners);

    const addressesMain: PublicKey[] = [];
    instructionsMain.forEach((ixn) => {
      ixn.keys.forEach((key) => {
        addressesMain.push(key.pubkey);
      });
    });
    const lookupTablesMain =
      lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain);
    const messageMain = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: txn.message.recentBlockhash,
      instructions: instructionsMain,
    }).compileToV0Message(lookupTablesMain);
    const txMain = new VersionedTransaction(messageMain);
    txMain.sign([payer]);

    const bundle = [txn, txSetUp, txMain];

    yield {
      bundle,
      arbSize,
      expectedProfit,
      hop1Dex: hop1Market.dex.label,
      hop2Dex: hop2Market.dex.label,
      sourceMint,
      intermediateMint,
      tipLamports,
      timings: {
        mempoolEnd: timings.mempoolEnd,
        preSimEnd: timings.preSimEnd,
        simEnd: timings.simEnd,
        postSimEnd: timings.postSimEnd,
        calcArbEnd: timings.calcArbEnd,
        buildBundleEnd: Date.now(),
        bundleSent: 0,
      },
    };
  }
}

export { buildBundle, Arb };
