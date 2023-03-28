import convict from 'convict';

const config = convict({
  block_engine_url: {
    format: String,
    default: 'frankfurt.mainnet.block-engine.jito.wtf',
    env: 'BLOCK_ENGINE_URL',
  },
  auth_keypair_path: {
    format: String,
    default: './auth.json',
    env: 'AUTH_KEYPAIR_PATH',
  },
  rpc_url: {
    format: String,
    default: 'https://api.mainnet-beta.solana.com',
    env: 'RPC_URL',
  },
  rpc_requests_per_second: {
    format: Number,
    default: 0,
    env: 'RPC_REQUESTS_PER_SECOND',
  },
  rpc_max_batch_size: {
    format: Number,
    default: 20,
    env: 'RPC_MAX_BATCH_SIZE',
  },
  geyser_url: {
    format: String,
    default: 'mainnet.rpc.jito.wtf',
    env: 'GEYSER_URL',
  },
  geyser_access_token: {
    format: String,
    default: '00000000-0000-0000-0000-000000000000',
    env: 'GEYSER_ACCESS_TOKEN',
  },
  arb_calculation_num_steps: {
    format: Number,
    default: 20,
    env: 'ARB_CALCULATION_NUM_STEPS',
  },
  payer_keypair_path: {
    format: String,
    default: './payer.json',
    env: 'PAYER_KEYPAIR_PATH',
  },
});

config.loadFile('.config.json');
config.validate({ allowed: 'strict' });

export { config };
