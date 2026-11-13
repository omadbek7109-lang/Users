import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { NewActionLog, Repository, TrackedQuery } from './repository.js';
import type {
  ActionLogRow,
  AiEditRow,
  BusinessChatRow,
  BusinessConnectionRow,
  DeleteTaskRow,
  GroupSettingsRow,
  MediaTaskRow,
  MediaTaskStatus,
  NewAiEdit,
  NewDeleteTask,
  NewMediaTask,
  NewStory,
  StoryRow,
  StoryStatus,
  TrackedMessageRow,
  UserRow,
  UserSettings,
} from './types.js';
import { redact, redactString } from '../utils/redact.js';

export class DatabaseError extends Error {
  constructor(op: string, message: string) {
    super(`DB ${op}: ${redactString(message)}`);
    this.name = 'DatabaseError';
  }
}

type Res<T> = { data: T | null; error: { message: string } | null };

function must<T>(op: string, res: Res<T>): T {
  if (res.error) throw new DatabaseError(op, res.error.message);
  return res.data as T;
}

/** Production repository. Uses the service_role key, so it must only ever run on the server. */
export class SupabaseRepository implements Repository {
  private readonly db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async ensureUser(telegramId: number, username?: string | null, firstName?: string | null): Promise<UserRow> {
    const res = await this.db
      .from('users')
      .upsert({ telegram_id: telegramId, username: username ?? null, first_name: firstName ?? null }, { onConflict: 'telegram_id' })
      .select()
      .single();
    return must('ensureUser', res) as UserRow;
  }
  async getUserByTelegramId(telegramId: number) {
    return must('getUser', await this.db.from('users').select().eq('telegram_id', telegramId).maybeSingle()) as UserRow | null;
  }
  async updateUserSettings(userId: string, settings: UserSettings) {
    const cur = must('getSettings', await this.db.from('users').select('settings').eq('id', userId).single()) as { settings: UserSettings };
    must('updateSettings', await this.db.from('users').update({ settings: { ...cur.settings, ...settings } }).eq('id', userId));
  }

  async upsertBusinessConnection(row: BusinessConnectionRow) {
    must('upsertBC', await this.db.from('business_connections').upsert(row, { onConflict: 'id' }));
  }
  async getBusinessConnection(id: string) {
    return must('getBC', await this.db.from('business_connections').select().eq('id', id).maybeSingle()) as BusinessConnectionRow | null;
  }
  async getActiveBusinessConnection(userId: string) {
    const res = await this.db
      .from('business_connections')
      .select()
      .eq('user_id', userId)
      .eq('is_enabled', true)
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return must('getActiveBC', res) as BusinessConnectionRow | null;
  }
  async touchBusinessChat(row: BusinessChatRow) {
    must('touchBChat', await this.db.from('business_chats').upsert(row, { onConflict: 'business_connection_id,chat_id' }));
  }
  async listRecentBusinessChats(connectionId: string, since: Date, limit: number) {
    const res = await this.db
      .from('business_chats')
      .select()
      .eq('business_connection_id', connectionId)
      .gte('last_incoming_at', since.toISOString())
      .order('last_incoming_at', { ascending: false })
      .limit(limit);
    return must('listBChats', res) as BusinessChatRow[];
  }

  async createStory(row: NewStory) {
    return must('createStory', await this.db.from('scheduled_stories').insert(row).select().single()) as StoryRow;
  }
  async getStory(id: string) {
    return must('getStory', await this.db.from('scheduled_stories').select().eq('id', id).maybeSingle()) as StoryRow | null;
  }
  async updateStory(id: string, patch: Partial<StoryRow>) {
    return must('updateStory', await this.db.from('scheduled_stories').update(patch).eq('id', id).select().single()) as StoryRow;
  }
  async listStories(userId: string, statuses: StoryStatus[], limit: number) {
    const res = await this.db
      .from('scheduled_stories')
      .select()
      .eq('user_id', userId)
      .in('status', statuses)
      .order('scheduled_at', { ascending: true })
      .limit(limit);
    return must('listStories', res) as StoryRow[];
  }

  async createMediaTask(row: NewMediaTask) {
    return must('createMedia', await this.db.from('media_tasks').insert(row).select().single()) as MediaTaskRow;
  }
  async getMediaTask(id: string) {
    return must('getMedia', await this.db.from('media_tasks').select().eq('id', id).maybeSingle()) as MediaTaskRow | null;
  }
  async updateMediaTask(id: string, patch: Partial<MediaTaskRow>) {
    return must('updateMedia', await this.db.from('media_tasks').update(patch).eq('id', id).select().single()) as MediaTaskRow;
  }
  async listMediaTasks(userId: string, statuses: MediaTaskStatus[], limit: number) {
    const res = await this.db
      .from('media_tasks')
      .select()
      .eq('user_id', userId)
      .in('status', statuses)
      .order('send_at', { ascending: true })
      .limit(limit);
    return must('listMedia', res) as MediaTaskRow[];
  }

  async upsertGroup(row: GroupSettingsRow) {
    must('upsertGroup', await this.db.from('group_settings').upsert(row, { onConflict: 'chat_id' }));
  }
  async getGroup(chatId: number) {
    return must('getGroup', await this.db.from('group_settings').select().eq('chat_id', chatId).maybeSingle()) as GroupSettingsRow | null;
  }
  async listGroups(userId: string) {
    return must('listGroups', await this.db.from('group_settings').select().eq('user_id', userId).order('title')) as GroupSettingsRow[];
  }
  async deleteGroup(chatId: number) {
    must('deleteGroup', await this.db.from('group_settings').delete().eq('chat_id', chatId));
  }

  async trackMessage(row: Omit<TrackedMessageRow, 'deleted'>) {
    must('track', await this.db.from('tracked_messages').upsert(row, { onConflict: 'chat_id,message_id', ignoreDuplicates: true }));
  }
  async listTrackedMessages(chatId: number, q: TrackedQuery) {
    let query = this.db
      .from('tracked_messages')
      .select()
      .eq('chat_id', chatId)
      .eq('deleted', false)
      .gte('sent_at', q.since.toISOString());
    if (q.onlyLinks) query = query.eq('has_link', true);
    const res = await query.order('message_id', { ascending: false }).limit(q.limit);
    return must('listTracked', res) as TrackedMessageRow[];
  }
  async markMessagesDeleted(chatId: number, messageIds: number[]) {
    if (!messageIds.length) return;
    must('markDeleted', await this.db.from('tracked_messages').update({ deleted: true }).eq('chat_id', chatId).in('message_id', messageIds));
  }
  async pruneTrackedMessages(before: Date) {
    const res = await this.db.from('tracked_messages').delete({ count: 'exact' }).lt('sent_at', before.toISOString());
    if (res.error) throw new DatabaseError('prune', res.error.message);
    return res.count ?? 0;
  }

  async createDeleteTask(row: NewDeleteTask) {
    return must('createDelete', await this.db.from('delete_tasks').insert(row).select().single()) as DeleteTaskRow;
  }
  async getDeleteTask(id: string) {
    return must('getDelete', await this.db.from('delete_tasks').select().eq('id', id).maybeSingle()) as DeleteTaskRow | null;
  }
  async updateDeleteTask(id: string, patch: Partial<DeleteTaskRow>) {
    return must('updateDelete', await this.db.from('delete_tasks').update(patch).eq('id', id).select().single()) as DeleteTaskRow;
  }
  async cancelPendingDeleteTasks(chatId: number) {
    const res = await this.db
      .from('delete_tasks')
      .update({ status: 'cancelled', finished_at: new Date().toISOString() }, { count: 'exact' })
      .eq('chat_id', chatId)
      .eq('status', 'pending_confirmation');
    if (res.error) throw new DatabaseError('cancelDelete', res.error.message);
    return res.count ?? 0;
  }

  async createAiEdit(row: NewAiEdit) {
    return must('createAi', await this.db.from('ai_edits').insert(row).select().single()) as AiEditRow;
  }
  async getAiEdit(id: string) {
    return must('getAi', await this.db.from('ai_edits').select().eq('id', id).maybeSingle()) as AiEditRow | null;
  }

  async log(entry: NewActionLog) {
    must('log', await this.db.from('action_logs').insert({ ...entry, details: redact(entry.details ?? {}) }));
  }
  async listLogs(userId: string, limit: number) {
    const res = await this.db.from('action_logs').select().eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    return must('listLogs', res) as ActionLogRow[];
  }
}
