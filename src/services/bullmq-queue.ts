import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { EnqueueOptions, JobData, JobName, JobQueue } from './queue.js';
import type { Logger } from './logger.js';

export const QUEUE_NAME = 'personal-telegram-ai';

export function createRedis(url: string): Redis {
  // maxRetriesPerRequest: null is required by BullMQ workers
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;
  constructor(connection: Redis) {
    this.queue = new Queue(QUEUE_NAME, { connection });
  }
  async enqueue(name: JobName, data: JobData, opts: EnqueueOptions) {
    const existing = await this.queue.getJob(opts.jobId);
    if (existing) await existing.remove().catch(() => undefined);
    const job = await this.queue.add(name, data, {
      jobId: opts.jobId,
      delay: Math.max(0, opts.delayMs ?? 0),
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
    return job.id ?? opts.jobId;
  }
  async remove(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    await job.remove();
    return true;
  }
  close() {
    return this.queue.close();
  }
}

export type JobProcessor = (name: JobName, data: JobData, ctx: { isFinalAttempt: boolean }) => Promise<void>;

export function startWorker(connection: Redis, processor: JobProcessor, logger: Logger): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const attempts = job.opts.attempts ?? 1;
      await processor(job.name as JobName, job.data as JobData, { isFinalAttempt: job.attemptsMade + 1 >= attempts });
    },
    { connection, concurrency: 4 },
  );
  worker.on('failed', (job, err) => logger.warn('job failed', { job: job?.name, id: job?.id, err }));
  worker.on('error', (err) => logger.error('worker error', { err }));
  return worker;
}
