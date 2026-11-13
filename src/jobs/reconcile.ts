import type { Repository } from '../database/repository.js';
import type { UserRow } from '../database/types.js';
import { jobIds, type JobQueue } from '../services/queue.js';
import type { Logger } from '../services/logger.js';

export interface ReconcileResult {
  storiesRequeued: number;
  storiesInterrupted: number;
  sendsRequeued: number;
  deletesRequeued: number;
}

const INTERRUPTED =
  'Bot qayta ishga tushganda story joylash jarayoni tugallanmagan edi. Ikki marta joylanib qolmasligi uchun avtomatik qayta urinilmadi — Telegram’da tekshiring va kerak bo‘lsa qayta yuboring.';

/**
 * Runs on startup. The database is the source of truth: every task that should still happen
 * gets a queue job again if Redis lost it (no persistence, flush, new instance).
 * Jobs that already exist are left untouched, so this is safe to run any number of times.
 */
export async function reconcileJobs(
  deps: { repo: Repository; queue: JobQueue; logger: Logger; now?: () => Date },
  owner: UserRow,
): Promise<ReconcileResult> {
  const { repo, queue, logger } = deps;
  const now = (deps.now?.() ?? new Date()).getTime();
  const res: ReconcileResult = { storiesRequeued: 0, storiesInterrupted: 0, sendsRequeued: 0, deletesRequeued: 0 };

  for (const s of await repo.listStories(owner.id, ['scheduled', 'posting'], 1000)) {
    const id = jobIds.story(s.id);
    if (await queue.has(id)) continue;
    if (s.status === 'scheduled') {
      await queue.enqueue('story.post', { id: s.id }, { jobId: id, delayMs: Math.max(0, new Date(s.scheduled_at).getTime() - now) });
      res.storiesRequeued++;
    } else {
      // 'posting' without a live job: the process died mid-upload. The story may or may not exist on Telegram.
      await repo.updateStory(s.id, { status: 'failed', error: INTERRUPTED });
      res.storiesInterrupted++;
    }
  }

  for (const m of await repo.listMediaTasks(owner.id, ['scheduled', 'sent'], 1000)) {
    if (m.status === 'scheduled') {
      const id = jobIds.mediaSend(m.id);
      if (await queue.has(id)) continue;
      await queue.enqueue('media.send', { id: m.id }, { jobId: id, delayMs: Math.max(0, new Date(m.send_at).getTime() - now) });
      res.sendsRequeued++;
    } else if (m.delete_at) {
      const id = jobIds.mediaDelete(m.id);
      if (await queue.has(id)) continue;
      await queue.enqueue('media.delete', { id: m.id }, { jobId: id, delayMs: Math.max(0, new Date(m.delete_at).getTime() - now) });
      res.deletesRequeued++;
    }
  }

  if (res.storiesRequeued || res.storiesInterrupted || res.sendsRequeued || res.deletesRequeued) {
    logger.info('reconciled jobs', res);
    await repo.log({ user_id: owner.id, module: 'scheduler', action: 'reconcile', status: 'info', details: { ...res } });
  }
  return res;
}
