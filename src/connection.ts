import { Connection } from '@solana/web3.js';
import EventEmitter from 'events';
import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch';
import { config } from './config.js';

const RPC_URL = config.get('rpc_url');
const RPC_REQUESTS_PER_SECOND = config.get('rpc_requests_per_second');

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
    setInterval(this.refill, this.intervalMs);
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

  const coalesceRequests = async () => {
    if (requestQueue.length === 0) return;

    const newBodies = [];
    const resolves = [];
    let lastUrl: RequestInfo;
    let lastOptions: RequestInit;

    // Coalesce requests with same URL and options
    for (let i = 1; i < requestQueue.length; i++) {
      const { url, optionsWithoutDefaults, resolve } = requestQueue[i];

      const body = JSON.parse(optionsWithoutDefaults.body);
      body.id = i;
      newBodies.push(body);
      resolves.push(resolve);
      lastUrl = url;
      lastOptions = optionsWithoutDefaults;
    }

    // Check if a token is available to send the coalesced request
    if (!rpcRateLimiter.tryConsume()) return;

    lastOptions.body = JSON.stringify(newBodies);
    const response = await fetch(lastUrl, lastOptions);

    // If the response is not OK, resolve all Promises with the response
    if (!response.ok) {
      for (const resolve of resolves) {
        resolve(response.clone());
      }
      return;
    }

    // If the response is OK, create a single response for each coalesced request and resolve the Promises
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await response.json();
    for (const item of json) {
      const singleResponse = new Response(JSON.stringify(item), {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
      resolves[item.id](singleResponse);
    }

    // Clear the request queue
    requestQueue.length = 0;
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
  });
} else {
  connection = new Connection(RPC_URL);
}

export { connection };
