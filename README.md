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
docker build . -t mev-bot
docker run \
    -d \
    -v /home/ubuntu/jito_backrun_bot_auth.json:/usr/src/app/auth.json:ro \
    -v /home/ubuntu/jito-testing-funded.json:/usr/src/app/payer.json:ro \
    --env-file .env.docker.local \
    --restart=on-failure \
    mev-bot
```
