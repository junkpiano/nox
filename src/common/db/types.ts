import type {
  NostrEvent,
  NostrProfile,
  PubkeyHex,
} from '../../../types/nostr.js';

// Database configuration
export const DB_NAME = 'nostr_cache_v2' as const;
// Bump when store/index definitions change so existing browsers run migrations.
export const DB_VERSION = 2 as const;

// Store names
export const STORE_NAMES = {
  EVENTS: 'events',
  PROFILES: 'profiles',
  TIMELINES: 'timelines',
  METADATA: 'metadata',
} as const;

// Storage limits
export const LIMITS = {
  EVENTS_HARD: 10000,
  EVENTS_SOFT: 10000,
  EVENTS_PRUNE_TO: 10000,
  PROFILES: 1000,
  TIMELINES: 50,
} as const;

// TTL in milliseconds
export const TTL = {
  EVENT_GENERAL: 14 * 24 * 60 * 60 * 1000, // 14 days
  EVENT_HOME: 30 * 24 * 60 * 60 * 1000, // 30 days
  PROFILE: 7 * 24 * 60 * 60 * 1000, // 7 days
  PROFILE_REFRESH: 24 * 60 * 60 * 1000, // 24 hours
} as const;

// Cached event record
export interface CachedEvent {
  id: string;
  event: NostrEvent;
  pubkey: string;
  kind: number;
  created_at: number;
  storedAt: number;
  isHomeTimeline?: boolean | undefined; // Protected from pruning
  /**
   * Set by the page, which checks an event before storing it. Absent on what
   * the service worker wrote, and on every record from before the mark
   * existed: both are checked on the way out instead.
   */
  verified?: boolean | undefined;
}

// Cached profile record
export interface CachedProfile {
  pubkey: PubkeyHex;
  profile: NostrProfile;
  storedAt: number;
  accessedAt: number;
}

// Timeline types
export type TimelineType = 'home' | 'global' | 'user';

export interface TimelineKey {
  type: TimelineType;
  pubkey?: PubkeyHex; // For home and user timelines
}

export interface Timeline {
  key: string; // "home:{pubkey}", "global", "user:{pubkey}"
  type: TimelineType;
  pubkey?: PubkeyHex | undefined;
  eventIds: string[]; // Ordered list of event IDs (newest first)
  newestTimestamp: number;
  oldestTimestamp: number;
  updatedAt: number;
}

// Metadata store
export interface Metadata {
  key: string;
  value: unknown;
  updatedAt: number;
}

// Cache statistics
export interface CacheStats {
  events: {
    count: number;
    bytes: number;
    protected: number; // Home timeline events
  };
  profiles: {
    count: number;
    bytes: number;
  };
  timelines: {
    count: number;
  };
  totalBytes: number;
}

// Sync status
export interface SyncStatus {
  lastSync: number;
  isOnline: boolean;
  activeTimelines: string[];
}

// Query options
export interface EventQueryOptions {
  limit?: number | undefined;
  offset?: number | undefined;
  since?: number | undefined;
  until?: number | undefined;
  kinds?: number[] | undefined;
  authors?: PubkeyHex[] | undefined;
}

// Transaction types
export type TransactionMode = 'readonly' | 'readwrite';

export type StoreName = (typeof STORE_NAMES)[keyof typeof STORE_NAMES];
