import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { EnqueueOptions, JobData, JobName, JobQueue } from './queue.js';
import type { Logger } from './logger.js';

export const QUEUE_NAME = 'personal-telegram-ai';
const LIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

export function createRedis(url: string): Redis {
  // maxRetriesPerRequest: null is required by BullMQ workers
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export interface BullQueueOptions {
  attempts?: number;
  backoffMs?: number;
  prefix?: string;
}

export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;
  private readonly attempts: number;
  private readonly backoffMs: number;

  constructor(connection: Redis, opts: BullQueueOptions = {}) {
    this.queue = new Queue(QUEUE_NAME, { connection, prefix: opts.prefix });
    this.attempts = opts.attempts ?? 3;
    this.backoffMs = opts.backoffMs ?? 10_000;
  }

  async enqueue(name: JobName, data: JobData, opts: EnqueueOptions) {
    const existing = await this.queue.getJob(opts.jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active') throw new Error(`Job ${opts.jobId} is running right now`);
      await existing.remove();
    }
    const job = await this.queue.add(name, data, {
      jobId: opts.jobId,
      delay: Math.max(0, opts.delayMs ?? 0),
      attempts: this.attempts,
      backoff: { type: 'exponential', delay: this.backoffMs },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
    return job.id ?? opts.jobId;
  }

  async remove(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    if ((await job.getState()) === 'active') return false;
    await job.remove();
    return true;
  }

  async has(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    return LIVE_STATES.has(await job.getState());
  }

  close() {
    return this.queue.close();
  }
}

export type JobProcessor = (name: JobName, data: JobData, ctx: { isFinalAttempt: boolean }) => Promise<void>;

export function startWorker(connection: Redis, processor: JobProcessor, logger: Logger, opts: { prefix?: string; concurrency?: number } = {}): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const attempts = job.opts.attempts ?? 1;
      await processor(job.name as JobName, job.data as JobData, { isFinalAttempt: job.attemptsMade + 1 >= attempts });
    },
    { connection, concurrency: opts.concurrency ?? 2, prefix: opts.prefix },
  );
  worker.on('failed', (job, err) => logger.warn('job failed', { job: job?.name, id: job?.id, err }));
  worker.on('error', (err) => logger.error('worker error', { err }));
  return worker;
}
