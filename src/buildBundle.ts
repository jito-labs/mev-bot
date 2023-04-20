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
const JSBI = defaultImport(jsbi);

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

    let expectedProfitLamports: jsbi.default;

    if (isUSDC) {
      expectedProfitLamports = usdcToSolMkt.jupiter.getQuote({
        sourceMint: BASE_MINTS_OF_INTEREST.USDC,
        destinationMint: BASE_MINTS_OF_INTEREST.SOL,
        amount: expectedProfit,
        swapMode: SwapMode.ExactIn,
      }).outAmount;
    } else {
      expectedProfitLamports = expectedProfit;
    }

    if (JSBI.lessThan(expectedProfitLamports, JSBI.BigInt(minProfit))) {
      logger.info(
        `Skipping due to profit (${expectedProfitLamports}) being less than min tip (${minProfit})`,
      );
      continue;
    }

    const tip = JSBI.divide(
      JSBI.multiply(expectedProfit, JSBI.BigInt(TIP_PERCENT)),
      JSBI.BigInt(100),
    );
    const tipLamports = JSBI.divide(
      JSBI.multiply(expectedProfitLamports, JSBI.BigInt(TIP_PERCENT)),
      JSBI.BigInt(100),
    );

    const minOut = JSBI.add(arbSize, tip);

    const setUpIxns: TransactionInstruction[] = [];
    const setUpSigners: Keypair[] = [payer];

    let sourceTokenAccount: PublicKey;

    if (!isUSDC) {
      const sourceTokenAccountKeypair = Keypair.generate();
      setUpSigners.push(sourceTokenAccountKeypair);

      sourceTokenAccount = sourceTokenAccountKeypair.publicKey;

      const createSourceTokenAccountIxn = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: sourceTokenAccountKeypair.publicKey,
        space: Token.ACCOUNT_SIZE,
        // it is fine using number here. max safe integer in lamports equals 9 mil sol. ain't gonna arb more than that
        lamports: MIN_BALANCE_RENT_EXEMPT_TOKEN_ACC + JSBI.toNumber(arbSize),
        programId: Token.TOKEN_PROGRAM_ID,
      });
      setUpIxns.push(createSourceTokenAccountIxn);

      const initSourceTokenAccountIxn =
        Token.createInitializeAccountInstruction(
          sourceTokenAccountKeypair.publicKey,
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

    const messageMain = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: txn.message.recentBlockhash,
      instructions: instructionsMain,
    }).compileToV0Message();
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
