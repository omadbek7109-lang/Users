import type { JobData, JobName } from '../services/queue.js';
import type { StoryService } from '../modules/stories/story.service.js';
import type { TimedMediaService } from '../modules/timed-media/timed-media.service.js';

export function createProcessor(deps: { stories: StoryService; media: TimedMediaService }) {
  return async (name: JobName, data: JobData, ctx: { isFinalAttempt: boolean }): Promise<void> => {
    switch (name) {
      case 'story.post':
        await deps.stories.runScheduled(data.id, ctx);
        return;
      case 'media.send':
        await deps.media.processSend(data.id, ctx);
        return;
      case 'media.delete':
        await deps.media.processDelete(data.id, ctx);
        return;
      default:
        throw new Error(`Unknown job: ${String(name)}`);
    }
  };
}
