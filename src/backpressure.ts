import { logger } from './logger.js';
import { Queue } from '@datastructures-js/queue';

class AsyncQueue<T> {
  private readonly _queue: Queue<T> = new Queue();
  private readonly _waitingResolvers: Queue<((value: T) => void)> = new Queue();

  put(item: T) {
    if (this._waitingResolvers.size() > 0) {
      const resolver = this._waitingResolvers.dequeue();
      if (resolver) {
        resolver(item);
      }
    } else {
      this._queue.push(item);
    }
  }

  async get(): Promise<T> {
    if (this._queue.size() > 0) {
      return this._queue.dequeue() as T;
    }

    return new Promise<T>((resolve) => {
      this._waitingResolvers.push(resolve);
    });
  }

  length(): number {
    return this._queue.size();
  }
}

async function* dropBeyondHighWaterMark<T>(
  iterable: AsyncGenerator<T>,
  highWaterMark: number,
  name: string,
): AsyncGenerator<T> {
  const queue = new AsyncQueue<T>();

  async function consume() {
    for await (const item of iterable) {
      if (queue.length() < highWaterMark) {
        queue.put(item);
      } else {
        logger.warn(
          `HighWaterMark of ${highWaterMark} reached. Dropping ${name}`,
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
