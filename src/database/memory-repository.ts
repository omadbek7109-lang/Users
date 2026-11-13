import { randomUUID } from 'node:crypto';
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
import { redact } from '../utils/redact.js';

/** In-memory implementation used by tests (and handy for local experiments). */
export class MemoryRepository implements Repository {
  constructor(private readonly clock: () => Date = () => new Date()) {}
  private ts() {
    return this.clock().toISOString();
  }

  users = new Map<string, UserRow>();
  connections = new Map<string, BusinessConnectionRow>();
  businessChats = new Map<string, BusinessChatRow>();
  stories = new Map<string, StoryRow>();
  media = new Map<string, MediaTaskRow>();
  groups = new Map<number, GroupSettingsRow>();
  tracked = new Map<string, TrackedMessageRow>();
  deleteTasks = new Map<string, DeleteTaskRow>();
  aiEdits = new Map<string, AiEditRow>();
  logs: ActionLogRow[] = [];

  async ensureUser(telegramId: number, username?: string | null, firstName?: string | null) {
    const existing = [...this.users.values()].find((u) => u.telegram_id === telegramId);
    if (existing) {
      existing.username = username ?? existing.username;
      existing.first_name = firstName ?? existing.first_name;
      return existing;
    }
    const u: UserRow = { id: randomUUID(), telegram_id: telegramId, username: username ?? null, first_name: firstName ?? null, settings: {} };
    this.users.set(u.id, u);
    return u;
  }
  async getUserByTelegramId(telegramId: number) {
    return [...this.users.values()].find((u) => u.telegram_id === telegramId) ?? null;
  }
  async updateUserSettings(userId: string, settings: UserSettings) {
    const u = this.users.get(userId);
    if (u) u.settings = { ...u.settings, ...settings };
  }

  async upsertBusinessConnection(row: BusinessConnectionRow) {
    this.connections.set(row.id, { ...row });
  }
  async getBusinessConnection(id: string) {
    return this.connections.get(id) ?? null;
  }
  async getActiveBusinessConnection(userId: string) {
    const list = [...this.connections.values()].filter((c) => c.user_id === userId && c.is_enabled);
    list.sort((a, b) => b.connected_at.localeCompare(a.connected_at));
    return list[0] ?? null;
  }
  async touchBusinessChat(row: BusinessChatRow) {
    this.businessChats.set(`${row.business_connection_id}:${row.chat_id}`, { ...row });
  }
  async listRecentBusinessChats(connectionId: string, since: Date, limit: number) {
    return [...this.businessChats.values()]
      .filter((c) => c.business_connection_id === connectionId && new Date(c.last_incoming_at) >= since)
      .sort((a, b) => b.last_incoming_at.localeCompare(a.last_incoming_at))
      .slice(0, limit);
  }

  async createStory(row: NewStory) {
    const s: StoryRow = {
      status: 'scheduled', posted_at: null, story_id: null, story_chat_id: null, attempts: 0, error: null, video_duration: null,
      ...row, id: randomUUID(), created_at: this.ts(),
    };
    this.stories.set(s.id, s);
    return { ...s };
  }
  async getStory(id: string) {
    const s = this.stories.get(id);
    return s ? { ...s } : null;
  }
  async updateStory(id: string, patch: Partial<StoryRow>) {
    const s = this.stories.get(id);
    if (!s) throw new Error('story not found');
    Object.assign(s, patch);
    return { ...s };
  }
  async listStories(userId: string, statuses: StoryStatus[], limit: number) {
    return [...this.stories.values()]
      .filter((s) => s.user_id === userId && statuses.includes(s.status))
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
      .slice(0, limit);
  }

  async createMediaTask(row: NewMediaTask) {
    const m: MediaTaskRow = {
      status: 'scheduled', sent_message_id: null, sent_at: null, delete_at: null, deleted_at: null, attempts: 0, error: null, target_title: null,
      ...row, id: randomUUID(), created_at: this.ts(),
    };
    this.media.set(m.id, m);
    return { ...m };
  }
  async getMediaTask(id: string) {
    const m = this.media.get(id);
    return m ? { ...m } : null;
  }
  async updateMediaTask(id: string, patch: Partial<MediaTaskRow>) {
    const m = this.media.get(id);
    if (!m) throw new Error('media task not found');
    Object.assign(m, patch);
    return { ...m };
  }
  async listMediaTasks(userId: string, statuses: MediaTaskStatus[], limit: number) {
    return [...this.media.values()]
      .filter((m) => m.user_id === userId && statuses.includes(m.status))
      .sort((a, b) => a.send_at.localeCompare(b.send_at))
      .slice(0, limit);
  }

  async upsertGroup(row: GroupSettingsRow) {
    this.groups.set(row.chat_id, { ...row });
  }
  async getGroup(chatId: number) {
    const g = this.groups.get(chatId);
    return g ? { ...g } : null;
  }
  async listGroups(userId: string) {
    return [...this.groups.values()].filter((g) => g.user_id === userId);
  }
  async deleteGroup(chatId: number) {
    this.groups.delete(chatId);
    for (const [k, v] of this.tracked) if (v.chat_id === chatId) this.tracked.delete(k);
  }

  async trackMessage(row: Omit<TrackedMessageRow, 'deleted'>) {
    if (!this.groups.has(row.chat_id)) throw new Error('FK violation: group not registered');
    this.tracked.set(`${row.chat_id}:${row.message_id}`, { ...row, deleted: false });
  }
  async listTrackedMessages(chatId: number, q: TrackedQuery) {
    return [...this.tracked.values()]
      .filter((m) => m.chat_id === chatId && !m.deleted && new Date(m.sent_at) >= q.since && (!q.onlyLinks || m.has_link))
      .sort((a, b) => b.message_id - a.message_id)
      .slice(0, q.limit);
  }
  async markMessagesDeleted(chatId: number, messageIds: number[]) {
    for (const id of messageIds) {
      const m = this.tracked.get(`${chatId}:${id}`);
      if (m) m.deleted = true;
    }
  }
  async pruneTrackedMessages(before: Date) {
    let n = 0;
    for (const [k, v] of this.tracked) if (new Date(v.sent_at) < before) { this.tracked.delete(k); n++; }
    return n;
  }

  async createDeleteTask(row: NewDeleteTask) {
    const t: DeleteTaskRow = {
      status: 'pending_confirmation', deleted_count: 0, error: null, confirmed_at: null, finished_at: null,
      ...row, id: randomUUID(), created_at: this.ts(),
    };
    this.deleteTasks.set(t.id, t);
    return { ...t };
  }
  async getDeleteTask(id: string) {
    const t = this.deleteTasks.get(id);
    return t ? { ...t } : null;
  }
  async updateDeleteTask(id: string, patch: Partial<DeleteTaskRow>) {
    const t = this.deleteTasks.get(id);
    if (!t) throw new Error('delete task not found');
    Object.assign(t, patch);
    return { ...t };
  }
  async cancelPendingDeleteTasks(chatId: number) {
    let n = 0;
    for (const t of this.deleteTasks.values()) {
      if (t.chat_id === chatId && t.status === 'pending_confirmation') { t.status = 'cancelled'; n++; }
    }
    return n;
  }

  async createAiEdit(row: NewAiEdit) {
    const e: AiEditRow = { ...row, id: randomUUID(), created_at: this.ts() };
    this.aiEdits.set(e.id, e);
    return { ...e };
  }
  async getAiEdit(id: string) {
    const e = this.aiEdits.get(id);
    return e ? { ...e } : null;
  }

  async log(entry: NewActionLog) {
    this.logs.push({
      id: this.logs.length + 1, user_id: entry.user_id, module: entry.module, action: entry.action,
      status: entry.status, details: redact(entry.details ?? {}), created_at: this.ts(),
    });
  }
  async listLogs(userId: string, limit: number) {
    return this.logs.filter((l) => l.user_id === userId).slice(-limit).reverse();
  }
}
