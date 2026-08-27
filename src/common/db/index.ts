// Core database

// Event writer (batched writes with debouncing)
export {
  eventWriter,
  flushEvents,
  writeEvent,
  writeEvents,
} from './event-writer.js';
// Events store
export {
  clearEvents,
  countEvents,
  countProtectedEvents,
  deleteEvents,
  getEvent,
  getEvents,
  getEventsByAuthor,
  pruneEvents,
  queryEvents,
  storeEvent,
  storeEvents,
} from './events-store.js';
export {
  closeDb,
  createTransaction,
  deleteDatabase,
  isIndexedDBAvailable,
  openDb,
  requestToPromise,
  transactionToPromise,
} from './indexeddb.js';
// Metadata store
export {
  clearMetadata,
  deleteMetadata,
  getAllMetadata,
  getCacheStats,
  getMetadata,
  getSyncStatus,
  setMetadata,
  setSyncStatus,
  updateLastSync,
} from './metadata-store.js';

// Profiles store
export {
  clearProfiles,
  countProfiles,
  deleteProfiles,
  getProfile,
  getProfiles,
  profileNeedsRefresh,
  pruneProfiles,
  storeProfile,
  storeProfiles,
} from './profiles-store.js';
// Timeline builder (batched timeline updates)
export {
  appendToTimeline,
  flushTimelines,
  prependToTimeline,
  timelineBuilder,
} from './timeline-builder.js';
// Timeline queries
export type { CachedTimelineResult } from './timeline-queries.js';
export {
  getCachedTimeline,
  getTimelineCacheSize,
  getTimelineNewestTimestamp,
  getTimelineOldestTimestamp,
  hasTimelineCache,
} from './timeline-queries.js';
// Timelines store
export {
  appendEventsToTimeline,
  clearTimelines,
  countTimelines,
  deleteTimeline,
  getAllTimelines,
  getTimeline,
  getTimelineKey,
  prependEventsToTimeline,
  pruneTimelines,
  removeEventFromTimeline,
  storeTimeline,
} from './timelines-store.js';
// Types and constants
export type {
  CachedEvent,
  CachedProfile,
  CacheStats,
  EventQueryOptions,
  Metadata,
  StoreName,
  SyncStatus,
  Timeline,
  TimelineKey,
  TimelineType,
  TransactionMode,
} from './types.js';
export {
  DB_NAME,
  DB_VERSION,
  LIMITS,
  STORE_NAMES,
  TTL,
} from './types.js';
