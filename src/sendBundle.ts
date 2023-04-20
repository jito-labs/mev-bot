import { Arb } from './buildBundle.js';
import { searcherClient } from './jitoClient.js';
import { logger } from './logger.js';
import { Bundle as JitoBundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import bs58 from 'bs58';
import { connection } from './connection.js';
import * as fs from 'fs';
import { stringify } from 'csv-stringify';

const CHECK_LANDED_DELAY_MS = 30000;

type Trade = {
  accepted: number;
  rejected: boolean;
  errorType: string | null;
  errorContent: string | null;
  landed: boolean;
} & Arb;

type TradeCSV = {
  timestamp: number;
  uuid: string;
  landed: boolean;
  accepted: number;
  rejected: boolean;
  errorType: string | null;
  errorContent: string | null;
  txn0Signature: string;
  txn1Signature: string;
  txn2Signature: string;
  arbSize: string;
  expectedProfit: string;
  hop1Dex: string;
  hop2Dex: string;
  sourceMint: string;
  intermediateMint: string;
  tipLamports: string;
  mempoolEnd: number;
  preSimEnd: number;
  simEnd: number;
  postSimEnd: number;
  calcArbEnd: number;
  buildBundleEnd: number;
  bundleSent: number;
};

const tradesCsv = fs.createWriteStream('trades.csv');
const stringifier = stringify({
  header: true,
});
stringifier.pipe(tradesCsv);

const bundlesInTransit = new Map<string, Trade>();

async function processCompletedTrade(uuid: string) {
  const trade = bundlesInTransit.get(uuid);

  const txn0Signature = bs58.encode(trade.bundle[0].signatures[0]);
  const txn1Signature = bs58.encode(trade.bundle[1].signatures[0]);
  const txn2Signature = bs58.encode(trade.bundle[2].signatures[0]);

  const txn2 = await connection.getTransaction(txn2Signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 10,
  });
  if (txn2 !== null) {
    trade.landed = true;
  }

  const tradeCsv: TradeCSV = {
    timestamp: Date.now(),
    uuid,
    landed: trade.landed,
    accepted: trade.accepted,
    rejected: trade.rejected,
    errorType: trade.errorType,
    errorContent: trade.errorContent,
    txn0Signature,
    txn1Signature,
    txn2Signature,
    arbSize: trade.arbSize.toString(),
    expectedProfit: trade.expectedProfit.toString(),
    hop1Dex: trade.hop1Dex,
    hop2Dex: trade.hop2Dex,
    sourceMint: trade.sourceMint.toString(),
    intermediateMint: trade.intermediateMint.toString(),
    tipLamports: trade.tipLamports.toString(),
    mempoolEnd: trade.timings.mempoolEnd,
    preSimEnd: trade.timings.preSimEnd,
    simEnd: trade.timings.simEnd,
    postSimEnd: trade.timings.postSimEnd,
    calcArbEnd: trade.timings.calcArbEnd,
    buildBundleEnd: trade.timings.buildBundleEnd,
    bundleSent: trade.timings.bundleSent,
  };
  stringifier.write(tradeCsv);
  bundlesInTransit.delete(uuid);
  return;
}

async function sendBundle(bundleIterator: AsyncGenerator<Arb>): Promise<void> {
  searcherClient.onBundleResult(
    (bundleResult) => {
      const bundleId = bundleResult.bundleId;
      const isAccepted = bundleResult.accepted;
      const isRejected = bundleResult.rejected;
      if (isAccepted) {
        logger.info(
          `Bundle ${bundleId} accepted in slot ${bundleResult.accepted.slot}`,
        );
        if (bundlesInTransit.has(bundleId)) {
          bundlesInTransit.get(bundleId).accepted += 1;
        }
      }
      if (isRejected) {
        logger.info(bundleResult.rejected, `Bundle ${bundleId} rejected:`);
        if (bundlesInTransit.has(bundleId)) {
          const trade: Trade = bundlesInTransit.get(bundleId);
          trade.rejected = true;
          const rejectedEntry = Object.entries(bundleResult.rejected).find(
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            ([_, value]) => value !== undefined,
          );
          const [errorType, errorContent] = rejectedEntry;
          trade.errorType = errorType;
          trade.errorContent = JSON.stringify(errorContent);
        }
      }
    },
    (error) => {
      logger.error(error);
      throw error;
    },
  );

  for await (const {
    bundle,
    arbSize,
    expectedProfit,
    hop1Dex,
    hop2Dex,
    sourceMint,
    intermediateMint,
    tipLamports,
    timings,
  } of bundleIterator) {
    const now = Date.now();
    searcherClient
      .sendBundle(new JitoBundle(bundle, 5))
      .then((bundleId) => {
        logger.info(
          `Bundle ${bundleId} sent, backrunning ${bs58.encode(
            bundle[0].signatures[0],
          )}`,
        );

        timings.bundleSent = now;
        logger.info(
          `chain timings: pre sim: ${
            timings.preSimEnd - timings.mempoolEnd
          }ms, sim: ${timings.simEnd - timings.preSimEnd}ms, post sim: ${
            timings.postSimEnd - timings.simEnd
          }ms, arb calc: ${
            timings.calcArbEnd - timings.postSimEnd
          }ms, build bundle: ${
            timings.buildBundleEnd - timings.calcArbEnd
          }ms send bundle: ${
            timings.bundleSent - timings.buildBundleEnd
          }ms ::: total ${now - timings.mempoolEnd}ms`,
        );

        bundlesInTransit.set(bundleId, {
          bundle,
          accepted: 0,
          rejected: false,
          errorType: null,
          errorContent: null,
          landed: false,
          arbSize,
          expectedProfit,
          hop1Dex,
          hop2Dex,
          sourceMint,
          intermediateMint,
          tipLamports,
          timings,
        });
        setTimeout(() => {
          processCompletedTrade(bundleId);
        }, CHECK_LANDED_DELAY_MS);
      })
      .catch((error) => {
        logger.error(error, 'error sending bundle');
        const txn0Signature = bs58.encode(bundle[0].signatures[0]);
        const txn1Signature = bs58.encode(bundle[1].signatures[0]);
        const txn2Signature = bs58.encode(bundle[2].signatures[0]);
        const tradeCsv: TradeCSV = {
          timestamp: Date.now(),
          uuid: '',
          landed: false,
          accepted: 0,
          rejected: true,
          errorType: 'sendingError',
          errorContent: JSON.stringify(error),
          txn0Signature,
          txn1Signature,
          txn2Signature,
          arbSize: arbSize.toString(),
          expectedProfit: expectedProfit.toString(),
          hop1Dex: hop1Dex,
          hop2Dex: hop2Dex,
          sourceMint: sourceMint.toString(),
          intermediateMint: intermediateMint.toString(),
          tipLamports: tipLamports.toString(),
          mempoolEnd: timings.mempoolEnd,
          preSimEnd: timings.preSimEnd,
          simEnd: timings.simEnd,
          postSimEnd: timings.postSimEnd,
          calcArbEnd: timings.calcArbEnd,
          buildBundleEnd: timings.buildBundleEnd,
          bundleSent: timings.bundleSent,
        };
        stringifier.write(tradeCsv);
      });
  }
}

export { sendBundle };
