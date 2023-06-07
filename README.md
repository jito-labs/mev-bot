# Jito Backrun Arb Bot

The Jito Backrun Arb Bot is designed to perform backrun arbs on the Solana blockchain, specifically targeting SOL and USDC trades. It utilizes the Jito mempool and bundles to backrun trades, focusing on circular arbitrage strategies. The bot supports multiple platforms including Raydium, Raydium CLMM, Orca Whirlpools, and Orca AMM pools.

## Overview

Backrunning in the context of decentralized finance (DeFi) is a strategy that takes advantage of the public nature of blockchain transactions. When a large trade is made on a decentralized exchange (DEX), it can cause a temporary imbalance in the price of the traded assets. A backrun is a type of arbitrage where a trader, or in this case a bot, sees this incoming trade and quickly places their own right after it, aiming to profit from the price imbalance.

The Jito Backrun Arb Bot implements this strategy in three main steps:

1. **Identifying trades to backrun**: The bot monitors the mempool for large incoming trades that could cause a significant price imbalance.

2. **Finding a profitable backrun arbitrage route**: The bot calculates potential profits from various arbitrage routes that could correct the price imbalance.

3. **Executing the arbitrage transaction**: The bot places its own trade immediately after the large trade is executed, then completes the arbitrage route to return the market closer to its original balance.

![Backrun Strategy Diagram](https://showme.redstarplugin.com/d/ZeHqaNDh)

## Detailed Explanation

### Identifying Trades to Backrun

The first step in the backrun strategy is to identify trades that can be backrun. This involves monitoring the mempool, which is a stream of pending transactions. For example, if a trade involving the sale of 250M BONK for 100 USDC on the Raydium exchange is detected, this trade can potentially be backrun.

To determine the direction and size of the trade, the bot simulates the transaction and observes the changes in the account balances. If the USDC vault for the BONK-USDC pair on Raydium decreases by $100, it indicates that someone sold BONK for 100 USDC. This means that the backrun will be at most 100 USDC to bring the markets back in balance.

During this process, the bot listens to the mempool for all transactions that touch any of the relevant decentralized exchanges (DEXs) using the `programSubscribe` function (see `mempool.ts`). Many transactions use lookup tables that need to be resolved first before we know whether the transaction includes any of the relevant vaults. The `lookup-table-provider.ts` is used for this purpose.

### Finding Profitable Backrun Arbitrage

The next step is to find a profitable backrun arbitrage opportunity. This involves considering all possible 2 and 3 hop routes. A hop is a pair, and in this context, it refers to a trade from one asset to another.

For example, if the original trade was a sale of BONK for USD on Raydium, the possible routes for backrun arbitrage could be:

- Buy BONK for USD on Raydium -> Sell BONK for USDC on another exchange (2 hop)
- Buy BONK for USD on Raydium -> Sell BONK for SOL on Raydium -> Sell SOL for USDC on another exchange (3 hop)

The bot calculates the potential profit for each route in increments of the original trade size divided by a predefined number of steps (`ARB_CALCULATION_NUM_STEPS`). The route with the highest potential profit is selected for the actual backrun.

For accurate calculations, the bot needs recent pool data. On startup, the bot subscribes to Geyser for all pool account changes. To perform the actual math, the bot uses Amm objects from the Jupiter SDK. These "calculator" objects are initialized and updated with the pool data from Geyser and can be used to calculate a quote. Each worker thread has its own set of these Amm objects, one for each pool (see `markets/amm-calc-worker.ts`).

### Executing the Arbitrage Transaction

The final step is to execute the arbitrage transaction. To do this without providing capital, the bot uses flashloans from Solend, a decentralized lending platform.

The basic structure of the arbitrage transaction is:

- Borrow SOL or USDC from Solend using a flashloan
- Execute the arbitrage route using the Jupiter program
- Repay the flashloan
- Tip the validator

The Jupiter program is used because it supports multi-hop swaps, which are necessary for executing the arbitrage route.

However, one challenge with executing the transaction is the transaction size. Some hops require a lot of accounts, which can make the transaction too large. To address this, the bot uses lookup tables to reduce the transaction size.

However, there's a constraint with jito bundles: a transaction in a bundle cannot use a lookup table that has been modified in the same bundle. To work around this, the bot caches all lookup tables it encounters in txns from the mempool in the `lookup-table-provider.ts` and then selects up to the three lookup tables that decrease the transaction size the most. This solution works well, especially after the bot has been running for a while.

Once the transaction is executed, the bot queries the RPC for the backrun transaction after a delay of 30 seconds. The result and other data are then recorded in a CSV file.

## How to run

### Pre-requisites

- block engine api keypair (see <https://jito-labs.gitbook.io/mev/searcher-resources/getting-started>)
- RPC running
  - jito-solana (because bot uses simulateBundle rpc call)
  - jito geyser plugin <https://github.com/jito-foundation/geyser-grpc-plugin>
  - no rate limit (doing a lot of getAccountInfo on startup and sometimes a lot of simulations)
- keypair of wallet with some sol
- multicore linux machine, preferably in same region with rpc and block engine
- 16gb of ram for running the bot with 4 worker threads
- nodejs 16 and yarn installed
- docker installed (optional)

### Run directly

1. Copy `.env.example` to `.env` and fill in the values.
`AUTH_KEYPAIR_PATH` is your block engine api keypair and
`PAYER_KEYPAIR_PATH` is your wallet keypair.
2. Run the following commands:

```bash
yarn install
yarn start
```

### Run with docker

1. Copy `.env.docker.example` to `.env.docker` and fill in the values. Leave `AUTH_KEYPAIR_PATH` and `PAYER_KEYPAIR_PATH` in the .env as they are.
2. Run the following commands:

```bash
sudo docker build . -t mev-bot
export AUTH_KEYPAIR_PATH=/path/to/your/block/engine/keypair.json
export PAYER_KEYPAIR_PATH=/path/to/your/wallet/keypair.json
touch docker.trades.csv
sudo docker run \
    -d \
    -v $AUTH_KEYPAIR_PATH:/usr/src/app/auth.json:ro \
    -v $PAYER_KEYPAIR_PATH:/usr/src/app/payer.json:ro \
    -v $PWD/docker.trades.csv:/usr/src/app/trades.csv \
    --env-file .env.docker.local \
    --restart=on-failure \
    mev-bot
```

## Directory Structure

- `./analyze/` - jupyter notebook for analyzing trades from the csv
- `./update-pool-lists.sh` - script for updating list of all pools
- `./src/bot.ts` - entrypoint for the bot
- `./src/clients/` - clients for rpc, block engine and geyser
- `./src/markets/` - logic for getting all the pools and calculating routes on them
