import convict from 'convict';

const config = convict({
  block_engine_url: {
    format: String,
    default: 'frankfurt.mainnet.block-engine.jito.wtf',
  },
  auth_keypair_path: {
    format: String,
    default: './auth.json',
  },
  rpc_url: {
    format: String,
    default: 'https://api.mainnet-beta.solana.com',
  },
});
config.loadFile('.config.json');
config.validate({ allowed: 'strict' });

export { config };
