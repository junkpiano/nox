// Service Worker for Nostr App Background Sync
// This runs independently from the main app and can perform background tasks

const SW_VERSION = 'v1.0.0';
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const _CACHE_NAME = 'nostr-app-v1';

console.log('[ServiceWorker] Initializing', SW_VERSION);

// Installation
self.addEventListener('install', (_event) => {
  console.log('[ServiceWorker] Installing');
  // Skip waiting to activate immediately
  self.skipWaiting();
});

// Activation
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activating');
  // Claim all clients immediately
  event.waitUntil(self.clients.claim());
});

// Message handling from main thread
self.addEventListener('message', (event) => {
  console.log('[ServiceWorker] Received message:', event.data);

  if (event.data.type === 'SYNC_TIMELINE') {
    handleTimelineSync(event.data.payload, event.source);
  } else if (event.data.type === 'START_PERIODIC_SYNC') {
    startPeriodicSync(event.data.payload);
  } else if (event.data.type === 'STOP_PERIODIC_SYNC') {
    stopPeriodicSync();
  } else if (event.data.type === 'PING') {
    event.source.postMessage({ type: 'PONG', version: SW_VERSION });
  }
});

// Periodic sync state
let syncIntervalId = null;
let syncConfig = null;

function startPeriodicSync(config) {
  console.log('[ServiceWorker] Starting periodic sync', config);

  syncConfig = config;

  // Clear any existing interval
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
  }

  // Start periodic sync
  syncIntervalId = setInterval(() => {
    performBackgroundSync();
  }, SYNC_INTERVAL_MS);

  // Perform initial sync immediately
  performBackgroundSync();
}

function stopPeriodicSync() {
  console.log('[ServiceWorker] Stopping periodic sync');

  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }

  syncConfig = null;
}

async function performBackgroundSync() {
  if (!syncConfig) {
    console.log('[ServiceWorker] No sync config, skipping');
    return;
  }

  console.log('[ServiceWorker] Performing background sync');

  try {
    // Sync home timeline if user is logged in
    if (syncConfig.userPubkey && syncConfig.followedPubkeys) {
      const result = await syncTimelineViaFetch(
        'home',
        syncConfig.userPubkey,
        syncConfig.followedPubkeys,
      );

      if (result.success && result.newEventCount > 0) {
        // Notify all clients about new events
        notifyClients({
          type: 'NEW_EVENTS',
          timelineType: 'home',
          count: result.newEventCount,
        });
      }
    }

    // Sync global timeline if enabled
    if (syncConfig.syncGlobal) {
      const result = await syncTimelineViaFetch('global');

      if (result.success && result.newEventCount > 0) {
        notifyClients({
          type: 'NEW_EVENTS',
          timelineType: 'global',
          count: result.newEventCount,
        });
      }
    }
  } catch (error) {
    console.error('[ServiceWorker] Background sync failed:', error);
  }
}

async function handleTimelineSync(payload, source) {
  console.log('[ServiceWorker] Handling timeline sync request');

  try {
    const result = await syncTimelineViaFetch(
      payload.timelineType,
      payload.userPubkey,
      payload.followedPubkeys,
    );

    source.postMessage({
      type: 'SYNC_RESULT',
      payload: result,
    });
  } catch (error) {
    console.error('[ServiceWorker] Sync failed:', error);
    source.postMessage({
      type: 'SYNC_RESULT',
      payload: {
        success: false,
        newEventCount: 0,
        error: error.message,
      },
    });
  }
}

// Notify all clients
async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => {
    client.postMessage(message);
  });
}

/**
 * Syncs a timeline using IndexedDB and WebSocket
 * This is a simplified version that runs in the service worker context
 */
async function syncTimelineViaFetch(timelineType, userPubkey, followedPubkeys) {
  try {
    // Open IndexedDB
    const db = await openDB();

    // Get newest timestamp from timeline
    const newestTimestamp = await getTimelineNewestTimestamp(
      db,
      timelineType,
      userPubkey,
    );

    if (!newestTimestamp) {
      console.log('[ServiceWorker] No cached timeline, skipping sync');
      db.close();
      return { success: true, newEventCount: 0 };
    }

    // Fetch new events from relays
    const relays = await getRelays(db);
    const newEvents = await fetchNewEventsFromRelays(
      relays,
      newestTimestamp,
      timelineType,
      followedPubkeys,
    );

    if (newEvents.length === 0) {
      db.close();
      return { success: true, newEventCount: 0 };
    }

    // Store events in IndexedDB
    await storeEventsInDB(db, newEvents, timelineType);

    // Update timeline index
    await updateTimelineIndex(db, timelineType, userPubkey, newEvents);

    console.log(`[ServiceWorker] Synced ${newEvents.length} new events`);

    db.close();

    return {
      success: true,
      newEventCount: newEvents.length,
    };
  } catch (error) {
    console.error('[ServiceWorker] Sync error:', error);
    // If error is "Database not initialized", return success with 0 events
    // This is expected on first load before the main app initializes the database
    if (error.message === 'Database not initialized') {
      console.log(
        '[ServiceWorker] Database not initialized yet, skipping sync',
      );
      return {
        success: true,
        newEventCount: 0,
      };
    }
    return {
      success: false,
      newEventCount: 0,
      error: error.message,
    };
  }
}

// IndexedDB helpers for service worker context
function openDB() {
  return new Promise((resolve, reject) => {
    // Open at whatever version the main app has created (no version argument),
    // so we never trigger an upgrade or fail with VersionError when the app's
    // DB_VERSION is ahead of a hardcoded number. The SW only reads/writes
    // existing stores; the main app owns the schema.
    const request = indexedDB.open('nostr_cache_v2');

    request.onsuccess = () => {
      const db = request.result;
      // Check if required object stores exist
      if (
        !db.objectStoreNames.contains('timelines') ||
        !db.objectStoreNames.contains('events')
      ) {
        console.warn(
          '[ServiceWorker] Required object stores not found, database not initialized yet',
        );
        db.close();
        reject(new Error('Database not initialized'));
        return;
      }
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

function getTimelineKey(type, pubkey) {
  if (type === 'home') {
    return `home:${pubkey || ''}`;
  }
  if (type === 'global') {
    return 'global';
  }
  if (type === 'user') {
    return `user:${pubkey || ''}`;
  }
  return `${type}:${pubkey || ''}`;
}

async function getTimelineNewestTimestamp(db, type, pubkey) {
  const key = getTimelineKey(type, pubkey);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('timelines', 'readonly');
      const store = tx.objectStore('timelines');
      const request = store.get(key);

      request.onsuccess = () => {
        const timeline = request.result;
        resolve(timeline?.newestTimestamp || 0);
      };
      request.onerror = () => reject(request.error);
    } catch (error) {
      console.error('[ServiceWorker] Failed to get timeline timestamp:', error);
      reject(error);
    }
  });
}

async function getRelays(_db) {
  // Try to get relays from localStorage or use defaults
  try {
    const relaysJson = self.localStorage?.getItem('nostr_relays');
    if (relaysJson) {
      return JSON.parse(relaysJson);
    }
  } catch (e) {
    console.warn('[ServiceWorker] Could not access localStorage:', e);
  }

  // Default relays
  return [
    'wss://relay.snort.social',
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://yabu.me',
  ];
}

async function fetchNewEventsFromRelays(
  relays,
  sinceTimestamp,
  timelineType,
  followedPubkeys,
) {
  const events = [];
  const seenIds = new Set();

  const filter = {
    kinds: [1],
    limit: 50,
    // Exclusive lower bound: `since` is inclusive in NIP-01, so without +1 the
    // newest already-cached event is re-fetched and counted as "new" every cycle.
    since: sinceTimestamp + 1,
  };

  if (
    timelineType === 'home' &&
    followedPubkeys &&
    followedPubkeys.length > 0
  ) {
    filter.authors = followedPubkeys;
  }

  const promises = relays.map(async (relayUrl) => {
    try {
      const socket = new WebSocket(relayUrl);

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          socket.close();
          resolve();
        }, 8000);

        socket.onopen = () => {
          const subId = `sw-sync-${Math.random().toString(36).slice(2)}`;
          socket.send(JSON.stringify(['REQ', subId, filter]));
        };

        socket.onmessage = (msg) => {
          try {
            const arr = JSON.parse(msg.data);
            if (arr[0] === 'EVENT' && arr[2]?.kind === 1) {
              const event = arr[2];
              if (!seenIds.has(event.id)) {
                seenIds.add(event.id);
                events.push(event);
              }
            } else if (arr[0] === 'EOSE') {
              clearTimeout(timeout);
              socket.close();
              resolve();
            }
          } catch (e) {
            console.warn('[ServiceWorker] Parse error:', e);
          }
        };

        socket.onerror = () => {
          clearTimeout(timeout);
          resolve();
        };

        socket.onclose = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    } catch (e) {
      console.warn('[ServiceWorker] Relay error:', e);
    }
  });

  await Promise.allSettled(promises);

  // Sort by timestamp (newest first)
  events.sort((a, b) => b.created_at - a.created_at);

  return events;
}

async function storeEventsInDB(db, events, timelineType) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readwrite');
    const store = tx.objectStore('events');

    const now = Date.now();
    for (const event of events) {
      store.put({
        id: event.id,
        event: event,
        pubkey: event.pubkey,
        kind: event.kind,
        created_at: event.created_at,
        storedAt: now,
        isHomeTimeline: timelineType === 'home',
      });
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function updateTimelineIndex(db, type, pubkey, events) {
  const key = getTimelineKey(type, pubkey);

  return new Promise((resolve, reject) => {
    const tx = db.transaction('timelines', 'readwrite');
    const store = tx.objectStore('timelines');

    const request = store.get(key);

    request.onsuccess = () => {
      const timeline = request.result;

      const eventIds = events.map((e) => e.id);
      const maxTimestamp = Math.max(...events.map((e) => e.created_at));
      const minTimestamp = Math.min(...events.map((e) => e.created_at));

      if (timeline) {
        const existingSet = new Set(timeline.eventIds || []);
        const newEventIds = eventIds.filter((id) => !existingSet.has(id));

        timeline.eventIds = [...newEventIds, ...(timeline.eventIds || [])];
        timeline.newestTimestamp = Math.max(
          timeline.newestTimestamp || 0,
          maxTimestamp,
        );
        // New events are newer, so oldestTimestamp generally should not move here.
        timeline.oldestTimestamp =
          typeof timeline.oldestTimestamp === 'number' &&
          timeline.oldestTimestamp > 0
            ? timeline.oldestTimestamp
            : minTimestamp;
        timeline.updatedAt = Date.now();
        store.put(timeline);
        return;
      }

      // Create timeline if missing (matches main app schema).
      store.put({
        key,
        type,
        pubkey: pubkey || undefined,
        eventIds,
        newestTimestamp: maxTimestamp,
        oldestTimestamp: minTimestamp,
        updatedAt: Date.now(),
      });
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Periodic Background Sync API (if supported)
if ('periodicSync' in self.registration) {
  self.addEventListener('periodicsync', (event) => {
    console.log('[ServiceWorker] Periodic sync event:', event.tag);

    if (event.tag === 'timeline-sync') {
      event.waitUntil(performBackgroundSync());
    }
  });
}

console.log('[ServiceWorker] Loaded', SW_VERSION);
