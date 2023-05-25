# Jito MEV Arb Bot

use node 16

Run with:
```bash
yarn install
yarn build
yarn start
```

or
```bash
sudo docker build . -t mev-bot
touch prod.trades.csv
sudo docker run \
    -d \
    -v /home/ubuntu/jito_backrun_bot_auth.json:/usr/src/app/auth.json:ro \
    -v /home/ubuntu/jito-testing-funded.json:/usr/src/app/payer.json:ro \
    -v /home/ubuntu/mev-bot/prod.trades.csv:/usr/src/app/trades.csv \
    --env-file .env.docker.local \
    --restart=on-failure \
    mev-bot
```
