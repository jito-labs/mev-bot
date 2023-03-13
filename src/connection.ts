import { Connection } from '@solana/web3.js';
import EventEmitter from 'events';
import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch';
import { config } from './config.js';
import { logger } from './logger.js';

const RPC_URL = config.get('rpc_url');
const RPC_REQUESTS_PER_SECOND = config.get('rpc_requests_per_second');
const RPC_MAX_BATCH_SIZE = config.get('rpc_max_batch_size');

// TokenBucket class for rate limiting requests
class TokenBucket extends EventEmitter {
  private readonly capacity: number;
  private readonly intervalMs: number;
  private tokens: number;
  private lastRefill: number;

  constructor(capacity: number, interval: number) {
    super();
    this.capacity = capacity;
    this.intervalMs = interval;
    this.tokens = capacity;
    this.lastRefill = Date.now();

    // Refill the bucket periodically
    setInterval(this.refill.bind(this), this.intervalMs);
  }

  private refill() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const intervalsPassed = Math.floor(timePassed / this.intervalMs);

    if (intervalsPassed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + intervalsPassed);
      this.lastRefill += intervalsPassed * this.intervalMs;
      this.emit('refill', this.tokens);
    }
  }

  public tryConsume(tokens = 1) {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }

    return false;
  }
}

const coalesceFetch = () => {
  const rpcRateLimiter = new TokenBucket(
    RPC_REQUESTS_PER_SECOND,
    1000 / RPC_REQUESTS_PER_SECOND,
  );
  const requestQueue: {
    url: RequestInfo;
    optionsWithoutDefaults: RequestInit;
    resolve: (value: Response | PromiseLike<Response>) => void;
  }[] = [];

  logger.info(
    `Initializing coalesced fetch with ${RPC_REQUESTS_PER_SECOND} requests per second`,
  );

  const coalesceRequests = async () => {
    if (requestQueue.length === 0) return;
    logger.debug(`${requestQueue.length} requests awaiting coalescing`);

    const newBodies = [];
    const resolves = [];
    let lastUrl: RequestInfo;
    let lastOptions: RequestInit;
    const startCoalescing = Date.now();

    // Coalesce requests with same URL and options
    let i = 0;
    while (requestQueue.length > 0 && i < RPC_MAX_BATCH_SIZE) {
      const { url, optionsWithoutDefaults, resolve } = requestQueue.shift();

      const body = JSON.parse(optionsWithoutDefaults.body);
      body.id = i.toString();
      newBodies.push(body);
      resolves.push(resolve);
      lastUrl = url;
      lastOptions = optionsWithoutDefaults;
      i++;
    }

    logger.debug(`Coalescing ${newBodies.length} requests`);

    const response = await fetch(lastUrl, {
      body: JSON.stringify(newBodies),
      headers: lastOptions.headers,
      method: lastOptions.method,
      agent: lastOptions.agent,
    });

    // If the response is not OK, resolve all Promises with the response
    if (!response.ok) {
      logger.debug('Response was not OK');
      for (const resolve of resolves) {
        resolve(response.clone());
      }
      requestQueue.length = 0;
      return;
    }

    // If the response is OK, create a single response for each coalesced request and resolve the Promises
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await response.json();

    logger.debug(`Resolving ${json.length} Responses`);

    for (const item of json) {
      const singleResponse = new Response(JSON.stringify(item), {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
      resolves[parseInt(item.id)](singleResponse);
    }

    logger.debug(
      `Coalesced ${json.length} requests in ${Date.now() - startCoalescing}ms`,
    );
  };

  // every time there is a new token available, try to coalesce requests
  rpcRateLimiter.on('refill', coalesceRequests);

  return async (
    url: RequestInfo,
    optionsWithoutDefaults: RequestInit,
  ): Promise<Response> => {
    if (rpcRateLimiter.tryConsume()) {
      return fetch(url, optionsWithoutDefaults);
    } else {
      return new Promise((resolve) => {
        requestQueue.push({ url, optionsWithoutDefaults, resolve });
      });
    }
  };
};

let connection: Connection;

if (RPC_REQUESTS_PER_SECOND > 0) {
  connection = new Connection(RPC_URL, {
    fetch: coalesceFetch(),
    disableRetryOnRateLimit: true,
  });
} else {
  connection = new Connection(RPC_URL);
}

export { connection };
