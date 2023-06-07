import {
  AccountMeta,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { ArbIdea } from './calculate-arb.js';
import * as fs from 'fs';
import { config } from './config.js';
import * as Token from '@solana/spl-token-3';
import { connection } from './clients/rpc.js';
import { BN } from 'bn.js';
import { IDL, JUPITER_PROGRAM_ID, SwapMode } from '@jup-ag/common';

import jsbi from 'jsbi';
import { defaultImport } from 'default-import';
import * as anchor from '@coral-xyz/anchor';
import { logger } from './logger.js';
import { Timings } from './types.js';
import {
  calculateQuote,
  calculateSwapLegAndAccounts,
  getMarketsForPair,
} from './markets/index.js';
import { lookupTableProvider } from './lookup-table-provider.js';
import {
  SOLEND_PRODUCTION_PROGRAM_ID,
  flashBorrowReserveLiquidityInstruction,
  flashRepayReserveLiquidityInstruction,
} from '@solendprotocol/solend-sdk';
import {
  BASE_MINTS_OF_INTEREST,
  SOLEND_FLASHLOAN_FEE_BPS,
  SOLEND_TURBO_POOL,
  SOLEND_TURBO_SOL_FEE_RECEIVER,
  SOLEND_TURBO_SOL_LIQUIDITY,
  SOLEND_TURBO_SOL_RESERVE,
  SOLEND_TURBO_USDC_FEE_RECEIVER,
  SOLEND_TURBO_USDC_LIQUIDITY,
  SOLEND_TURBO_USDC_RESERVE,
} from './constants.js';
import { SwapLegAndAccounts } from '@jup-ag/core/dist/lib/amm.js';
const JSBI = defaultImport(jsbi);

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

// three signatrues (up to two for set up txn, one for main tx)
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
  BASE_MINTS_OF_INTEREST.SOL.toBase58(),
  BASE_MINTS_OF_INTEREST.USDC.toBase58(),
).filter(
  (market) =>
    // hardcode market to orca 0.05% fee SOL/USDC
    market.id === '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm',
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
  hop3Dex: string;
  sourceMint: PublicKey;
  intermediateMint1: PublicKey;
  intermediateMint2: PublicKey | null;
  tipLamports: jsbi.default;
  timings: Timings;
};

const ataCache = new Map<string, PublicKey>();
const getAta = (mint: PublicKey, owner: PublicKey) => {
  const key = `${mint.toBase58()}-${owner.toBase58()}`;
  if (ataCache.has(key)) {
    return ataCache.get(key);
  }
  const ata = Token.getAssociatedTokenAddressSync(mint, owner);
  ataCache.set(key, ata);
  return ata;
};

async function* buildBundle(
  arbIdeaIterator: AsyncGenerator<ArbIdea>,
): AsyncGenerator<Arb> {
  for await (const {
    txn,
    arbSize,
    expectedProfit,
    route,
    timings,
  } of arbIdeaIterator) {
    const hop0 = route[0];
    const hop0SourceMint = new PublicKey(
      hop0.fromA ? hop0.market.tokenMintA : hop0.market.tokenMintB,
    );
    const isUSDC = hop0SourceMint.equals(BASE_MINTS_OF_INTEREST.USDC);

    const flashloanFee = JSBI.divide(
      JSBI.multiply(arbSize, JSBI.BigInt(SOLEND_FLASHLOAN_FEE_BPS)),
      JSBI.BigInt(10000),
    );

    const expectedProfitMinusFee = expectedProfit; //JSBI.subtract(expectedProfit, flashloanFee);

    let expectedProfitLamports: jsbi.default;

    if (isUSDC) {
      expectedProfitLamports = (
        await calculateQuote(
          usdcToSolMkt.id,
          {
            sourceMint: BASE_MINTS_OF_INTEREST.USDC,
            destinationMint: BASE_MINTS_OF_INTEREST.SOL,
            amount: expectedProfitMinusFee,
            swapMode: SwapMode.ExactIn,
          },
          undefined,
          true,
        )
      ).outAmount;
    } else {
      expectedProfitLamports = expectedProfitMinusFee;
    }

    if (JSBI.lessThan(expectedProfitLamports, JSBI.BigInt(minProfit))) {
      logger.info(
        `Skipping due to profit (${expectedProfitLamports}) being less than min (${minProfit})`,
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
          hop0SourceMint,
          payer.publicKey,
        );
      setUpIxns.push(initSourceTokenAccountIxn);
    } else {
      sourceTokenAccount = USDC_ATA.address;
    }

    const intermediateMints: PublicKey[] = [];
    intermediateMints.push(
      new PublicKey(
        hop0.fromA ? hop0.market.tokenMintB : hop0.market.tokenMintA,
      ),
    );
    if (route.length > 2) {
      intermediateMints.push(
        new PublicKey(
          route[1].fromA
            ? route[1].market.tokenMintB
            : route[1].market.tokenMintA,
        ),
      );
    }

    intermediateMints.forEach((mint) => {
      const intermediateTokenAccount = getAta(mint, payer.publicKey);

      const createIntermediateTokenAccountIxn =
        Token.createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          intermediateTokenAccount,
          payer.publicKey,
          mint,
        );
      setUpIxns.push(createIntermediateTokenAccountIxn);
    });

    const legs = {
      chain: {
        swapLegs: [],
      },
    };
    const allSwapAccounts: AccountMeta[] = [];

    const legAndAccountsPromises: Promise<SwapLegAndAccounts>[] = [];

    route.forEach(async (hop, i) => {
      const sourceMint = new PublicKey(
        hop.fromA ? hop.market.tokenMintA : hop.market.tokenMintB,
      );
      const destinationMint = new PublicKey(
        hop.fromA ? hop.market.tokenMintB : hop.market.tokenMintA,
      );
      const userSourceTokenAccount =
        i === 0 ? sourceTokenAccount : getAta(sourceMint, payer.publicKey);
      const userDestinationTokenAccount =
        i === route.length - 1
          ? sourceTokenAccount
          : getAta(destinationMint, payer.publicKey);
      const legAndAccountsPromise = calculateSwapLegAndAccounts(
        hop.market.id,
        {
          sourceMint,
          destinationMint,
          userSourceTokenAccount,
          userDestinationTokenAccount,
          userTransferAuthority: payer.publicKey,
          amount: i === 0 ? arbSize : JSBI.BigInt(1),
          swapMode: SwapMode.ExactIn,
        },
        undefined,
        true,
      );
      legAndAccountsPromises.push(legAndAccountsPromise);
    });

    const legAndAccounts = await Promise.all(legAndAccountsPromises);

    for (const [leg, accounts] of legAndAccounts) {
      legs.chain.swapLegs.push(leg);
      allSwapAccounts.push(...accounts);
    }

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
        remainingAccounts: allSwapAccounts,
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
    try {
      const serializedMsg = txMain.serialize();
      if (serializedMsg.length > 1232) {
        logger.error('tx too big');
        continue;
      }
      txMain.sign([payer]);
    } catch (e) {
      logger.error(e, 'error signing txMain');
      continue;
    }

    const bundle = [txn, txSetUp, txMain];

    yield {
      bundle,
      arbSize,
      expectedProfit,
      hop1Dex: route[0].market.dexLabel,
      hop2Dex: route[1].market.dexLabel,
      hop3Dex: route[2] ? route[2].market.dexLabel : '',
      sourceMint: hop0SourceMint,
      intermediateMint1: intermediateMints[0],
      intermediateMint2: intermediateMints[1] ? intermediateMints[1] : null,
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
