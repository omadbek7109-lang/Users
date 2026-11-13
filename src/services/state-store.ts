import type { Redis } from 'ioredis';
import type { MediaType } from '../database/types.js';

export interface PendingMedia {
  type: MediaType;
  fileId: string;
  caption?: string;
  duration?: number;
  fileSize?: number;
}

export interface StoryDraft {
  media: PendingMedia;
  caption: string;
  activePeriod: number;
  postToChatPage: boolean;
  protectContent: boolean;
}

export interface MediaDraft {
  media: PendingMedia;
  caption: string;
  targetChatId?: number;
  targetTitle?: string;
  businessConnectionId?: string;
  deleteAfter: number | null;
  hasSpoiler: boolean;
  protectContent: boolean;
}

export type BotState =
  | { kind: 'idle' }
  | { kind: 'media_pick'; media: PendingMedia }
  | { kind: 'story_draft'; draft: StoryDraft; awaiting?: 'caption' | 'time' }
  | { kind: 'story_edit_caption'; storyId: string }
  | { kind: 'media_draft'; draft: MediaDraft; awaiting?: 'caption' | 'time' };

export interface StateStore {
  get(userKey: number): Promise<BotState>;
  set(userKey: number, state: BotState, ttlSec?: number): Promise<void>;
  clear(userKey: number): Promise<void>;
}

const DEFAULT_TTL = 60 * 60; // 1 hour

export class MemoryStateStore implements StateStore {
  private map = new Map<number, { s: BotState; exp: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async get(k: number): Promise<BotState> {
    const e = this.map.get(k);
    if (!e || e.exp < this.now()) return { kind: 'idle' };
    return e.s;
  }
  async set(k: number, s: BotState, ttl = DEFAULT_TTL) {
    this.map.set(k, { s, exp: this.now() + ttl * 1000 });
  }
  async clear(k: number) {
    this.map.delete(k);
  }
}

export class RedisStateStore implements StateStore {
  constructor(private readonly redis: Redis) {}
  private key(k: number) {
    return `pta:state:${k}`;
  }
  async get(k: number): Promise<BotState> {
    const raw = await this.redis.get(this.key(k));
    if (!raw) return { kind: 'idle' };
    try {
      return JSON.parse(raw) as BotState;
    } catch {
      return { kind: 'idle' };
    }
  }
  async set(k: number, s: BotState, ttl = DEFAULT_TTL) {
    await this.redis.set(this.key(k), JSON.stringify(s), 'EX', ttl);
  }
  async clear(k: number) {
    await this.redis.del(this.key(k));
  }
}
