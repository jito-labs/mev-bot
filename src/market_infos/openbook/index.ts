import * as fs from 'fs';
import { Market as OpenbookMarket } from '@project-serum/serum';
import { PublicKey } from '@solana/web3.js';
import { connection } from '../../connection.js';
import { DEX, Market } from '../types.js';
import { SerumAmm } from '@jup-ag/core';
import { GeyserJupiterUpdateHandler, toPairString } from '../common.js';
import { AccountSubscriptionHandlersMap, geyserClient } from '../../geyser.js';
import { logger } from '../../logger.js';

const MARKETS_TO_IGNORE = [
  '3MDDGsxXBM6iwSPqD4C5xzKTsi3WbMz8bKrsipVELNU8',
  '71V8jsA4bffEgroERNArQxURacWafN7a4w5FQn3sR2iW',
  'DGb9wVrheYrTphXLSSU1JpKmq4s3774EVK5ydpsNmXe1',
  '3HZyvGDbANadNGf8Fxx4VEKC8E6iNtzp721s4X8XY4Ha',
  'EDiB6wZLwxRec6n4vrS6H1wPJud8gdFTVRfwYv4LWwhk',
  'GaztgeZX66EjBbu8yrQrRsUnXzDddGS8Y7UUwgZUpUyL',
  '4doXpYyy5QbwDUmtNeaChbRcQ3SkC6sG8Zxw3c1Jjey4',
  '3GrNvLrtcxxqF3pQbaDbQxZBQW9EsoqRh3TV1FS9rpjD',
  'G3vxcWUgSvXx6NYnhfQak7yooNpnLzUhT1UjsWsgss8d',
  'BdNSD6oPv7Jsu1bzmUcToGSWK2S2AinMt8xCxaTk3jfj',
  '5Xu4RP4HRjf6MjL5Fwmomo23Rq9XnTwMgpC1CJ8ZUQCr',
  'GQmb4reT3HavbiYvgKVHrv5uLYdKwWM3FGKb4Z45FneH',
  '3YBEhXXDJhjCvTtz5RnmQvSaNrxLZ2WxZryg2736ruKZ',
  'BepwKuzP3cMoqqt7G3NBuPtdeCXE2oHxbwWW6JBbkFFR',
  '4GFGqL1udpwr49bMWDMXZNkEG8a9um23AHAZxdA6SHmd',
  'A5mihWNWWCaYHCN8LrVk2tVV4baN8tyCNUUerx4rtpC7',
  'GMGpgwy59F5US756hDs93WGP5tASPt326QQdqJC8YDQq',
];

const OPENBOOK_PROGRAM_ID = new PublicKey(
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
);

const markets_json = JSON.parse(
  fs.readFileSync('./src/market_infos/openbook/markets.json', 'utf-8'),
) as { address: string; programId: string }[];

const markets_only_openbook = markets_json
  .filter((market) => market.programId === OPENBOOK_PROGRAM_ID.toBase58())
  .filter((market) => !MARKETS_TO_IGNORE.includes(market.address));

const fetchMarketPromises = [];
const openbookMarkets: OpenbookMarket[] = [];

for (const market of markets_only_openbook) {
  fetchMarketPromises.push(
    OpenbookMarket.load(
      connection,
      new PublicKey(market.address),
      { skipPreflight: true },
      OPENBOOK_PROGRAM_ID,
    )
      .then((market) => {
        // need mkt with 0 decimals otherwise jupiter quote calc breaks
        const market0Decimals = new OpenbookMarket(
          market.decoded,
          0,
          0,
          {},
          OPENBOOK_PROGRAM_ID,
        );
        openbookMarkets.push(market0Decimals);
      })
      .catch((e) => {
        logger.error(
          `OPENBOOK: Failed fetching market ${market.address}: ${e}`,
        );
      }),
  );
}

await Promise.all(fetchMarketPromises);

class OpenbookDEX extends DEX {
  constructor() {
    super('OPENBOOK');

    const allOpenbookAccountSubscriptionHandlers: AccountSubscriptionHandlersMap =
      new Map();

    for (const openbookMarket of openbookMarkets) {
      const openbookAmm = new SerumAmm(openbookMarket);

      const geyserUpdateHandler = new GeyserJupiterUpdateHandler(openbookAmm);
      const updateHandlers = geyserUpdateHandler.getUpdateHandlers();
      updateHandlers.forEach((handlers, address) => {
        if (allOpenbookAccountSubscriptionHandlers.has(address)) {
          allOpenbookAccountSubscriptionHandlers.get(address).push(...handlers);
        } else {
          allOpenbookAccountSubscriptionHandlers.set(address, handlers);
        }
      });
      this.updateHandlerInitPromises.push(
        geyserUpdateHandler.waitForInitialized(),
      );

      const poolBaseMint = new PublicKey(openbookMarket.baseMintAddress);
      const poolQuoteMint = new PublicKey(openbookMarket.quoteMintAddress);
      const poolBaseVault = new PublicKey(0);
      const poolQuoteVault = new PublicKey(0);

      const market: Market = {
        tokenMintA: poolBaseMint,
        tokenVaultA: poolBaseVault,
        tokenMintB: poolQuoteMint,
        tokenVaultB: poolQuoteVault,
        dex: this,
        jupiter: openbookAmm,
      };

      this.marketsByVault.set(poolBaseVault.toBase58(), market);
      this.marketsByVault.set(poolQuoteVault.toBase58(), market);
      const pairString = toPairString(poolBaseMint, poolQuoteMint);
      if (this.pairToMarkets.has(pairString)) {
        this.pairToMarkets.get(pairString).push(market);
      } else {
        this.pairToMarkets.set(pairString, [market]);
      }
    }

    geyserClient.addSubscriptions(allOpenbookAccountSubscriptionHandlers);
  }

  // can't backrun trades on openbook as they don't change the market price, only increase spread
  getMarketTokenAccountsForTokenMint(): PublicKey[] {
    return [];
  }
}

export { OpenbookDEX };
