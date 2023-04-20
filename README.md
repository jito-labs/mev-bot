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
export JITO_REGION=fra
touch $JITO_REGION.trades.csv
sudo docker run \
    -d \
    -v /home/ubuntu/jito_backrun_bot_auth.json:/usr/src/app/auth.json:ro \
    -v /home/ubuntu/jito-testing-funded.json:/usr/src/app/payer.json:ro \
    -v /home/ubuntu/mev-bot/$JITO_REGION.trades.csv:/usr/src/app/trades.csv \
    --env-file .env.docker.$JITO_REGION.local \
    --restart=on-failure \
    mev-bot
```
