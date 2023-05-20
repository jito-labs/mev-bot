/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events';
import { Worker } from 'worker_threads';
import { logger } from './logger.js';

type ResolveFunc = (value: any) => void;
type RejectFunc = (reason: any) => void;

class TaskContainer {
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

class WorkerPool extends EventEmitter {
  private size: number;
  private workerPath: string;
  private workers: PoolWorker[] = [];
  private sharedTaskQueue: TaskContainer[] = [];
  private perWorkerTaskQueue: TaskContainer[][] = [];

  constructor(size: number, workerPath: string) {
    super();
    this.size = size;
    this.workerPath = workerPath;

    for (let i = 0; i < this.size; i++) {
      this.perWorkerTaskQueue.push([]);
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

  private processTask(worker: PoolWorker): void {
    const task =
      this.perWorkerTaskQueue[worker.id].shift() ||
      this.sharedTaskQueue.shift();

    if (!task) {
      return;
    }

    const { param, resolve, reject } = task;

    worker.run(param).then(resolve).catch(reject);
  }

  async runTask<TParam, TResult>(
    param: TParam,
    timeout?: number,
  ): Promise<TResult> {
    return new Promise((resolve, reject) => {
      const task = new TaskContainer(param, resolve, reject);

      this.sharedTaskQueue.push(task);
      const worker = this.getIdleWorker();

      if (worker) {
        this.processTask(worker);
      }

      if (timeout !== undefined) {
        setTimeout(() => {
          const taskIndex = this.sharedTaskQueue.indexOf(task);
          if (taskIndex !== -1) {
            this.sharedTaskQueue.splice(taskIndex, 1);
            resolve(null); // resolve the promise with null if it times out
          }
        }, timeout);
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
