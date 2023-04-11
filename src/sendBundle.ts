import { Bundle } from './buildBundle.js';
import { searcherClient } from './jitoClient.js';
import { logger } from './logger.js';
import { Bundle as JitoBundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import bs58 from 'bs58';

async function sendBundle(
  bundleIterator: AsyncGenerator<Bundle>,
): Promise<void> {
  searcherClient.onBundleResult(
    (bundleResult) => {
      const bundleId = bundleResult.bundleId;
      const isAccepted = bundleResult.accepted;
      const isRejected = bundleResult.rejected;
      if (isAccepted) {
        logger.info(
          `Bundle ${bundleId} accepted in slot ${bundleResult.accepted.slot}`,
        );
      }
      if (isRejected) {
        logger.info(bundleResult.rejected, `Bundle ${bundleId} rejected:`);
      }
    },
    (error) => {
      logger.error(error);
      throw error;
    },
  );

  for await (const { bundle, timings } of bundleIterator) {
    const now = Date.now();
    searcherClient
      .sendBundle(new JitoBundle(bundle, 5))
      .then((bundleId) => {
        logger.info(
          `Bundle ${bundleId} sent, backrunning ${bs58.encode(
            bundle[0].signatures[0],
          )}`,
        );
        logger.info(
          `chain timings: pre sim: ${
            timings.preSimEnd - timings.mempoolEnd
          }ms, sim: ${timings.simEnd - timings.preSimEnd}ms, post sim: ${
            timings.postSimEnd - timings.simEnd
          }ms, arb calc: ${
            timings.calcArbEnd - timings.postSimEnd
          }ms, build bundle: ${
            timings.buildBundleEnd - timings.calcArbEnd
          }ms send bundle: ${now - timings.buildBundleEnd}ms ::: total ${
            now - timings.mempoolEnd
          }ms`,
        );
      })
      .catch((error) => {
        logger.error(error, 'error sending bundle');
      });
  }
}

export { sendBundle };
