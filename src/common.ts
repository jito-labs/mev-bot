import { logger } from './logger.js';

class AsyncQueue<T> {
  private readonly _queue: T[] = [];
  private readonly _waitingResolvers: ((value: T) => void)[] = [];

  put(item: T) {
    if (this._waitingResolvers.length > 0) {
      const resolver = this._waitingResolvers.shift();
      if (resolver) {
        resolver(item);
      }
    } else {
      this._queue.push(item);
    }
  }

  async get(): Promise<T> {
    if (this._queue.length > 0) {
      return this._queue.shift() as T;
    }

    return new Promise<T>((resolve) => {
      this._waitingResolvers.push(resolve);
    });
  }

  length(): number {
    return this._queue.length;
  }
}

async function* dropBeyondHighWaterMark<T>(
  iterable: AsyncGenerator<T>,
  highWaterMark: number,
): AsyncGenerator<T> {
  const queue = new AsyncQueue<T>();

  async function consume() {
    for await (const item of iterable) {
      if (queue.length() < highWaterMark) {
        queue.put(item);
      } else {
        logger.warn(
          `HighWaterMark of ${highWaterMark} reached. Dropping item: ${(typeof item).toString()}`,
        );
      }
    }
  }

  consume();

  while (true) {
    const item = await queue.get();
    yield item;
  }
}

export { dropBeyondHighWaterMark };
