#!/usr/bin/env sh

wget https://api.orca.so/allPools -O ./src/markets/orca/mainnet.json
wget https://api.mainnet.orca.so/v1/whirlpool/list -O ./src/markets/orca-whirlpool/mainnet.json
wget https://api.raydium.io/v2/sdk/liquidity/mainnet.json -O ./src/markets/raydium/mainnet.json
wget https://api.raydium.io/v2/ammV3/ammPools -O ./src/markets/raydium-clmm/mainnet.json
