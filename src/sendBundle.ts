import { Bundle } from './buildBundle.js';
import { Timings } from './types.js';
import { searcherClient } from './jitoClient.js';
import { logger } from './logger.js';
import { Bundle as JitoBundle } from 'jito-ts/dist/sdk/block-engine/types.js';

const sentBundleTimings: Map<string, Timings> = new Map();

async function sendBundle(
  bundleIterator: AsyncGenerator<Bundle>,
): Promise<void> {
  searcherClient.onBundleResult(
    (bundleResult) => {
      const bundleId = bundleResult.bundleId;
      const isAccepted = bundleResult.accepted;
      const isRejected = bundleResult.rejected;
      const timings = sentBundleTimings.get(bundleId);

      // edge case this runs before the timings are set due to promise scheduling
      if (!timings) {
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
          }ms ::: total ${timings.bundleSent - timings.mempoolEnd}ms (${
            Date.now() - timings.bundleSent
          }ms to get result)`,
        );
      }
      if (isAccepted) {
        logger.info(
          `Bundle ${bundleId} accepted in slot ${bundleResult.accepted.slot}`,
        );
      }
      if (isRejected) {
        logger.info(
          `Bundle ${bundleId} rejected: ${JSON.stringify(
            bundleResult.rejected,
          )}`,
        );
      }
    },
    (error) => logger.error(error),
  );

  for await (const { bundle, timings } of bundleIterator) {
    searcherClient.sendBundle(new JitoBundle(bundle, 5)).then((bundleId) => {
      logger.info(
        `Bundle ${bundleId} sent, backrunning ${bundle[0].signatures}`,
      );
      sentBundleTimings.set(bundleId, {
        mempoolEnd: timings.mempoolEnd,
        preSimEnd: timings.preSimEnd,
        simEnd: timings.simEnd,
        postSimEnd: timings.postSimEnd,
        calcArbEnd: timings.calcArbEnd,
        buildBundleEnd: timings.buildBundleEnd,
        bundleSent: Date.now(),
      });
    });
  }
}

export { sendBundle };
