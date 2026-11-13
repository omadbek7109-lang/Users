import type { TgBusinessBotRights } from '../types/telegram.js';
import type { AiProviderName } from '../config/env.js';

export type MediaType = 'photo' | 'video';

export interface UserSettings {
  aiProvider?: AiProviderName;
}

export interface UserRow {
  id: string;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  settings: UserSettings;
}

export interface BusinessConnectionRow {
  id: string;
  user_id: string;
  user_chat_id: number;
  rights: TgBusinessBotRights;
  is_enabled: boolean;
  connected_at: string;
}

export interface BusinessChatRow {
  business_connection_id: string;
  chat_id: number;
  title: string | null;
  last_incoming_at: string;
}

export type StoryStatus = 'scheduled' | 'posting' | 'posted' | 'failed' | 'cancelled' | 'deleted';

export interface StoryRow {
  id: string;
  user_id: string;
  business_connection_id: string;
  media_type: MediaType;
  file_id: string;
  video_duration: number | null;
  caption: string | null;
  active_period: number;
  post_to_chat_page: boolean;
  protect_content: boolean;
  status: StoryStatus;
  scheduled_at: string;
  posted_at: string | null;
  story_id: number | null;
  story_chat_id: number | null;
  attempts: number;
  error: string | null;
  created_at: string;
}

export type MediaTaskStatus = 'scheduled' | 'sent' | 'deleted' | 'failed' | 'cancelled';

export interface MediaTaskRow {
  id: string;
  user_id: string;
  target_chat_id: number;
  target_title: string | null;
  business_connection_id: string | null;
  media_type: MediaType;
  file_id: string;
  caption: string | null;
  has_spoiler: boolean;
  protect_content: boolean;
  send_at: string;
  delete_after_seconds: number | null;
  status: MediaTaskStatus;
  sent_message_id: number | null;
  sent_at: string | null;
  delete_at: string | null;
  deleted_at: string | null;
  attempts: number;
  error: string | null;
  created_at: string;
}

export interface GroupSettingsRow {
  chat_id: number;
  user_id: string;
  title: string | null;
  bot_can_delete: boolean;
  track_messages: boolean;
}

export interface TrackedMessageRow {
  chat_id: number;
  message_id: number;
  from_user_id: number | null;
  has_link: boolean;
  sent_at: string;
  deleted: boolean;
}

export type DeleteMode = 'last_n' | 'links' | 'clear';
export type DeleteTaskStatus = 'pending_confirmation' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled';

export interface DeleteTaskRow {
  id: string;
  user_id: string;
  chat_id: number;
  mode: DeleteMode;
  requested_count: number | null;
  message_ids: number[];
  status: DeleteTaskStatus;
  deleted_count: number;
  error: string | null;
  created_at: string;
  confirmed_at: string | null;
  finished_at: string | null;
}

export interface AiEditRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  root_id: string | null;
  provider: string | null;
  operation: string;
  source_text: string;
  result_text: string;
  created_at: string;
}

export interface ActionLogRow {
  id: number;
  user_id: string | null;
  module: string;
  action: string;
  status: 'ok' | 'error' | 'info';
  details: Record<string, unknown>;
  created_at: string;
}

type Insert<T, Optional extends keyof T> = Omit<T, Optional> & Partial<Pick<T, Optional>>;

export type NewStory = Insert<
  Omit<StoryRow, 'id' | 'created_at'>,
  'status' | 'posted_at' | 'story_id' | 'story_chat_id' | 'attempts' | 'error' | 'video_duration'
>;
export type NewMediaTask = Insert<
  Omit<MediaTaskRow, 'id' | 'created_at'>,
  'status' | 'sent_message_id' | 'sent_at' | 'delete_at' | 'deleted_at' | 'attempts' | 'error' | 'target_title'
>;
export type NewDeleteTask = Insert<
  Omit<DeleteTaskRow, 'id' | 'created_at'>,
  'status' | 'deleted_count' | 'error' | 'confirmed_at' | 'finished_at'
>;
export type NewAiEdit = Omit<AiEditRow, 'id' | 'created_at'>;
