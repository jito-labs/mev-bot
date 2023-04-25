FROM node:16-bullseye

# node doesnt like to run as pid 1 so install dumb-init to avoid that
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init
WORKDIR /usr/src/app
COPY --chown=node:node . .
RUN yarn install --frozen-lockfile
ENV NODE_ENV production
RUN yarn build
USER node

CMD ["dumb-init", "node", "--max-old-space-size=8192", "--max-semi-space-size=256", "build/src/bot.js"]
