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

export interface TrackedQuery {
  since: Date;
  onlyLinks?: boolean;
  limit: number;
}

export interface NewActionLog {
  user_id: string | null;
  module: string;
  action: string;
  status: ActionLogRow['status'];
  details?: Record<string, unknown>;
}

/** Storage abstraction. Implemented by SupabaseRepository (prod) and MemoryRepository (tests). */
export interface Repository {
  ensureUser(telegramId: number, username?: string | null, firstName?: string | null): Promise<UserRow>;
  getUserByTelegramId(telegramId: number): Promise<UserRow | null>;
  updateUserSettings(userId: string, settings: UserSettings): Promise<void>;

  upsertBusinessConnection(row: BusinessConnectionRow): Promise<void>;
  getBusinessConnection(id: string): Promise<BusinessConnectionRow | null>;
  getActiveBusinessConnection(userId: string): Promise<BusinessConnectionRow | null>;
  touchBusinessChat(row: BusinessChatRow): Promise<void>;
  listRecentBusinessChats(connectionId: string, since: Date, limit: number): Promise<BusinessChatRow[]>;

  createStory(row: NewStory): Promise<StoryRow>;
  getStory(id: string): Promise<StoryRow | null>;
  updateStory(id: string, patch: Partial<StoryRow>): Promise<StoryRow>;
  listStories(userId: string, statuses: StoryStatus[], limit: number): Promise<StoryRow[]>;

  createMediaTask(row: NewMediaTask): Promise<MediaTaskRow>;
  getMediaTask(id: string): Promise<MediaTaskRow | null>;
  updateMediaTask(id: string, patch: Partial<MediaTaskRow>): Promise<MediaTaskRow>;
  listMediaTasks(userId: string, statuses: MediaTaskStatus[], limit: number): Promise<MediaTaskRow[]>;

  upsertGroup(row: GroupSettingsRow): Promise<void>;
  getGroup(chatId: number): Promise<GroupSettingsRow | null>;
  listGroups(userId: string): Promise<GroupSettingsRow[]>;
  deleteGroup(chatId: number): Promise<void>;

  trackMessage(row: Omit<TrackedMessageRow, 'deleted'>): Promise<void>;
  /** Newest first, not deleted, sent after `since`. */
  listTrackedMessages(chatId: number, q: TrackedQuery): Promise<TrackedMessageRow[]>;
  markMessagesDeleted(chatId: number, messageIds: number[]): Promise<void>;
  pruneTrackedMessages(before: Date): Promise<number>;

  createDeleteTask(row: NewDeleteTask): Promise<DeleteTaskRow>;
  getDeleteTask(id: string): Promise<DeleteTaskRow | null>;
  updateDeleteTask(id: string, patch: Partial<DeleteTaskRow>): Promise<DeleteTaskRow>;
  cancelPendingDeleteTasks(chatId: number): Promise<number>;

  createAiEdit(row: NewAiEdit): Promise<AiEditRow>;
  getAiEdit(id: string): Promise<AiEditRow | null>;

  log(entry: NewActionLog): Promise<void>;
  listLogs(userId: string, limit: number): Promise<ActionLogRow[]>;
}
