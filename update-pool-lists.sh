#!/usr/bin/env sh

wget https://api.orca.so/allPools -O ./src/market-infos/orca/mainnet.json
wget https://api.mainnet.orca.so/v1/whirlpool/list -O ./src/market-infos/orca-whirlpool/mainnet.json
wget https://api.raydium.io/v2/sdk/liquidity/mainnet.json -O ./src/market-infos/raydium/mainnet.json
wget https://api.raydium.io/v2/ammV3/ammPools -O ./src/market-infos/raydium-clmm/mainnet.json
