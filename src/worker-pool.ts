/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events';
import { Worker } from 'worker_threads';
import { logger } from './logger.js';
import { Queue } from '@datastructures-js/queue';

type ResolveFunc = (value: any) => void;
type RejectFunc = (reason: any) => void;

class TaskContainer {
  isCanelled = false;
  constructor(
    public param: any,
    public resolve: ResolveFunc,
    public reject: RejectFunc,
  ) {}
}

class PoolWorker extends Worker {
  ready = false;
  id: number;

  constructor(id: number, ...args: ConstructorParameters<typeof Worker>) {
    super(...args);
    this.id = id;

    this.once('online', () => this.setReadyToWork());
  }

  private setReadyToWork(): void {
    this.ready = true;
    this.emit('ready', this);
  }

  async run(param: any): Promise<any> {
    this.ready = false;

    const taskPromise = new Promise((resolve, reject) => {
      const onMessage = (res: any) => {
        this.removeListener('error', onError);
        this.setReadyToWork();
        resolve(res);
      };

      const onError = (err: any) => {
        this.removeListener('message', onMessage);
        reject(err);
      };

      this.once('message', onMessage);
      this.once('error', onError);
      this.postMessage(param);
    });

    return taskPromise;
  }
}

// custom worker pool impl bcs couldn't find one that supports distributing a task to all workers
class WorkerPool extends EventEmitter {
  private size: number;
  private workerPath: string;
  private workers: PoolWorker[] = [];
  private taskQueue: Queue<TaskContainer> = new Queue();
  private highPriorityTaskQueue: Queue<TaskContainer> = new Queue();
  private perWorkerTaskQueue: Queue<TaskContainer>[] = [];

  constructor(size: number, workerPath: string) {
    super();
    this.size = size;
    this.workerPath = workerPath;

    for (let i = 0; i < this.size; i++) {
      this.perWorkerTaskQueue.push(new Queue());
    }

    this.on('worker-ready', (worker) => {
      this.processTask(worker);
    });
  }

  public async initialize(): Promise<void> {
    const isOnline: Promise<void>[] = [];
    for (let i = 0; i < this.size; i++) {
      const worker = new PoolWorker(i, this.workerPath, {
        workerData: { workerId: i },
      });
      this.workers.push(worker);
      isOnline.push(
        new Promise((resolve) => {
          worker.once('online', () => {
            resolve();
            this.emit('worker-ready', worker);
          });
        }),
      );
      worker.on('ready', (worker) => this.emit('worker-ready', worker));
      worker.once('exit', (code) => {
        logger.error(`Worker exited with code ${code}`);
        throw new Error(`Worker exited with code ${code}`);
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return Promise.all(isOnline).then(() => {});
  }

  private getIdleWorker(): PoolWorker | null {
    const worker = this.workers.find((worker) => worker.ready);

    return worker ?? null;
  }

  private getNextTaskFromSharedQueue(): TaskContainer | undefined {
    while (!this.highPriorityTaskQueue.isEmpty() || !this.taskQueue.isEmpty()) {
      const task =
        this.highPriorityTaskQueue.dequeue() || this.taskQueue.dequeue();
      if (!task.isCanelled) {
        return task;
      }
    }
    return undefined;
  }

  private processTask(worker: PoolWorker): void {
    let task: TaskContainer | undefined;

    const randomChance = Math.random(); // generates a random number between 0 (inclusive) and 1 (exclusive)

    // doing this to not starve either queue
    if (randomChance < 0.5) {
      // 50% chance to try the per-worker queue first
      task =
        this.perWorkerTaskQueue[worker.id].dequeue() ||
        this.getNextTaskFromSharedQueue();
    } else {
      // 50% chance to try the shared queue first
      task =
        this.getNextTaskFromSharedQueue() ||
        this.perWorkerTaskQueue[worker.id].dequeue();
    }

    if (!task) {
      return;
    }

    logger.trace(
      `Worker ${
        worker.id
      } is processing task. shared queue size: ${this.taskQueue.size()}, per worker queue size: ${this.perWorkerTaskQueue[
        worker.id
      ].size()}`,
    );
    const { param, resolve, reject } = task;

    worker.run(param).then(resolve).catch(reject);
  }

  async runTask<TParam, TResult>(
    param: TParam,
    timeout?: number,
    prioritze?: boolean,
  ): Promise<TResult> {
    return new Promise((resolve, reject) => {
      const task = new TaskContainer(param, resolve, reject);

      if (prioritze) {
        this.highPriorityTaskQueue.enqueue(task);
      } else {
        this.taskQueue.enqueue(task);
      }

      const worker = this.getIdleWorker();

      if (worker) {
        this.processTask(worker);
      }

      if (timeout !== undefined) {
        setTimeout(() => {
          task.isCanelled = true;
          resolve(null); // resolve the promise with null if it times out
        }, Math.max(timeout, 0));
      }
    });
  }

  runTaskOnAllWorkers<TParam, TResult>(param: TParam): Promise<TResult>[] {
    const taskPromises: Promise<TResult>[] = [];

    for (let i = 0; i < this.size; i++) {
      const taskPromise: Promise<TResult> = new Promise(
        (taskResolve, taskReject) => {
          const task = new TaskContainer(param, taskResolve, taskReject);
          this.perWorkerTaskQueue[i].push(task);
        },
      );
      taskPromises.push(taskPromise);
    }

    for (const worker of this.workers) {
      if (worker.ready) {
        this.processTask(worker);
      }
    }

    return taskPromises;
  }
}

export { WorkerPool };
