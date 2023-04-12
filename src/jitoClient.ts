import { Keypair } from '@solana/web3.js';
import { config } from './config.js';
import { geyserClient as jitoGeyserClient } from 'jito-ts';

import { searcherClient as jitoSearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import * as fs from 'fs';

const BLOCK_ENGINE_URL = config.get('block_engine_url');
const AUTH_KEYPAIR_PATH = config.get('auth_keypair_path');

const GEYSER_URL = config.get('geyser_url');
const GEYSER_ACCESS_TOKEN = config.get('geyser_access_token');

const decodedKey = new Uint8Array(
  JSON.parse(fs.readFileSync(AUTH_KEYPAIR_PATH).toString()) as number[],
);
const keypair = Keypair.fromSecretKey(decodedKey);

const searcherClient = jitoSearcherClient(BLOCK_ENGINE_URL, keypair, {
  'grpc.keepalive_timeout_ms': 4000,
});

const geyserClient = jitoGeyserClient(GEYSER_URL, GEYSER_ACCESS_TOKEN, {
  'grpc.keepalive_timeout_ms': 4000,
});

export { searcherClient, geyserClient };
