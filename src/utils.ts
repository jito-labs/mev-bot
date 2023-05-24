import { logger } from './logger.js';
import { Queue } from '@datastructures-js/queue';

class AsyncQueue<T> {
  private readonly _queue: Queue<T> = new Queue();
  private readonly _waitingResolvers: Queue<(value: T) => void> = new Queue();

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

function shuffle<T>(array: Array<T>) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function toDecimalString(origNumberStr: string, decimalPlaces: number): string {
  // If the string is of length equal to or less than decimalPlaces, add '0.' before it
  if (origNumberStr.length <= decimalPlaces) {
    const decimalString = '0.' + origNumberStr.padStart(decimalPlaces, '0');
    return decimalString;
  } else {
    // If the string is larger than decimalPlaces, format it with the correct number of decimal places
    const integerPart = origNumberStr.slice(0, -decimalPlaces);
    const decimalPart = origNumberStr.slice(-decimalPlaces);
    return integerPart + '.' + decimalPart;
  }
}

async function* fuseGenerators<T>(
  gens: AsyncGenerator<T>[],
): AsyncGenerator<T> {
  const generatorPromises: Array<
    Promise<{ result: IteratorResult<T>; generatorIndex: number }>
  > = gens.map((gen, index) =>
    gen.next().then((result) => ({ result, generatorIndex: index })),
  );

  while (true) {
    const { result, generatorIndex } = await Promise.race(generatorPromises);
    yield result.value;
    generatorPromises[generatorIndex] = gens[generatorIndex]
      .next()
      .then((result) => ({ result, generatorIndex }));
  }
}

export { dropBeyondHighWaterMark, shuffle, toDecimalString, fuseGenerators };
