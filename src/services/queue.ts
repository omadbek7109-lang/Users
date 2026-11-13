export type JobName = 'story.post' | 'media.send' | 'media.delete';

export interface JobData {
  id: string; // scheduled_stories.id or media_tasks.id
}

export interface EnqueueOptions {
  delayMs?: number;
  jobId: string;
}

/** Scheduler abstraction (BullMQ in production, MemoryQueue in tests). */
export interface JobQueue {
  enqueue(name: JobName, data: JobData, opts: EnqueueOptions): Promise<string>;
  remove(jobId: string): Promise<boolean>;
}

/** Deterministic job ids — BullMQ custom ids must not contain ':' */
export const jobIds = {
  story: (id: string) => `story-${id}`,
  mediaSend: (id: string) => `media-send-${id}`,
  mediaDelete: (id: string) => `media-del-${id}`,
};

export interface QueuedJob {
  name: JobName;
  data: JobData;
  delayMs: number;
  jobId: string;
}

export class MemoryQueue implements JobQueue {
  jobs: QueuedJob[] = [];
  async enqueue(name: JobName, data: JobData, opts: EnqueueOptions) {
    this.jobs = this.jobs.filter((j) => j.jobId !== opts.jobId);
    this.jobs.push({ name, data, delayMs: opts.delayMs ?? 0, jobId: opts.jobId });
    return opts.jobId;
  }
  async remove(jobId: string) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.jobId !== jobId);
    return this.jobs.length < before;
  }
  take(jobId: string): QueuedJob | undefined {
    const j = this.jobs.find((x) => x.jobId === jobId);
    if (j) this.jobs = this.jobs.filter((x) => x !== j);
    return j;
  }
}
