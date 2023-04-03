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

const MIN_TIP_LAMPORTS = config.get('min_tip_lamports');
//const TIP_PERCENT = config.get('tip_percent');

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

type Bundle = {
  timings: Timings;
};

async function* buildBundle(
  arbIdeaIterator: AsyncGenerator<ArbIdea>,
): AsyncGenerator<Bundle> {
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

    if (JSBI.lessThan(expectedProfitLamports, JSBI.BigInt(MIN_TIP_LAMPORTS))) {
      logger.info(
        `Skipping due to profit (${expectedProfitLamports}) being less than min tip (${MIN_TIP_LAMPORTS})`,
      );
      continue;
    }

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

    const intermediateTokenAccountKeypair = Keypair.generate();
    setUpSigners.push(intermediateTokenAccountKeypair);

    const intermediateTokenAccount = intermediateTokenAccountKeypair.publicKey;

    const createIntermediateTokenAccountIxn = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: intermediateTokenAccountKeypair.publicKey,
      space: Token.ACCOUNT_SIZE,
      lamports: MIN_BALANCE_RENT_EXEMPT_TOKEN_ACC,
      programId: Token.TOKEN_PROGRAM_ID,
    });
    setUpIxns.push(createIntermediateTokenAccountIxn);

    const initIntermediateTokenAccountIxn =
      Token.createInitializeAccountInstruction(
        intermediateTokenAccountKeypair.publicKey,
        intermediateMint,
        payer.publicKey,
      );
    setUpIxns.push(initIntermediateTokenAccountIxn);

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

    const jupiterIxn = await jupiterProgram.methods
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .route(legs as any, new BN(arbSize.toString()), new BN(0), 0, 0)
      .accounts({
        tokenProgram: Token.TOKEN_PROGRAM_ID,
        userTransferAuthority: payer.publicKey,
        destinationTokenAccount: sourceTokenAccount,
      })
      .remainingAccounts(hop1Accounts.concat(hop2Accounts))
      .signers([payer])
      .instruction();

    const messageSetUp = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: txn.message.recentBlockhash,
      instructions: setUpIxns,
    }).compileToV0Message();
    const txSetUp = new VersionedTransaction(messageSetUp);
    txSetUp.sign(setUpSigners);

    const instructionsMain: TransactionInstruction[] = [jupiterIxn];

    const messageMain = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: txn.message.recentBlockhash,
      instructions: instructionsMain,
    }).compileToV0Message();
    const txMain = new VersionedTransaction(messageMain);
    txMain.sign([payer]);

    const simResult = await connection.simulateBundle([txn, txSetUp, txMain], {
      preExecutionAccountsConfigs: [null, null, null],
      postExecutionAccountsConfigs: [null, null, null],
      simulationBank: 'tip',
    });

    logger.warn(simResult.value.transactionResults[0].logs.toString());
    logger.warn('------------------');
    logger.warn(simResult.value.transactionResults[1].logs.toString());
    logger.warn('------------------');
    logger.warn(simResult.value.transactionResults[2].logs.toString());

    yield {
      timings: {
        mempoolEnd: timings.mempoolEnd,
        preSimEnd: timings.preSimEnd,
        simEnd: timings.simEnd,
        postSimEnd: timings.postSimEnd,
        calcArbEnd: timings.calcArbEnd,
        buildBundleEnd: Date.now(),
      },
    };
  }
}

export { buildBundle };
