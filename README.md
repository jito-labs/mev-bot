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
docker run \
    -v /root/jito_backrun_bot_auth.json:/usr/src/app/auth.json:ro \
    -v /root/jito-testing-funded.json:/usr/src/app/payer.json:ro \
    --env-file .env \
    mev-bot
```
