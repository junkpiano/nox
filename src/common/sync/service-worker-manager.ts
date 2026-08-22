import type { PubkeyHex } from '../../../types/nostr.js';
import { isNativeRuntime } from '../native-http.js';

let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
let syncConfig: {
  userPubkey?: PubkeyHex;
  followedPubkeys?: PubkeyHex[];
  syncGlobal?: boolean;
} | null = null;

export interface ServiceWorkerManager {
  register: () => Promise<boolean>;
  startPeriodicSync: (config: {
    userPubkey?: PubkeyHex;
    followedPubkeys?: PubkeyHex[];
    syncGlobal?: boolean;
  }) => Promise<void>;
  stopPeriodicSync: () => Promise<void>;
  isSupported: () => boolean;
  getRegistration: () => ServiceWorkerRegistration | null;
}

/**
 * Registers the service worker
 *
 * Background sync is web-only. The native shell serves the app from a custom
 * protocol origin that cannot host a worker script, and mobile platforms would
 * not keep a relay connection alive in the background anyway, so the native
 * build skips registration instead of failing at it on every launch.
 */
export async function registerServiceWorker(): Promise<boolean> {
  if (isNativeRuntime()) {
    return false;
  }

  if (!('serviceWorker' in navigator)) {
    console.warn('[ServiceWorkerManager] Service workers not supported');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.register(
      '/service-worker.js',
      {
        scope: '/',
      },
    );

    serviceWorkerRegistration = registration;

    console.log(
      '[ServiceWorkerManager] Service worker registered:',
      registration.scope,
    );

    // Listen for updates
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (newWorker) {
        console.log('[ServiceWorkerManager] New service worker installing');
        newWorker.addEventListener('statechange', () => {
          console.log(
            '[ServiceWorkerManager] Service worker state:',
            newWorker.state,
          );
        });
      }
    });

    // Listen for messages from service worker
    navigator.serviceWorker.addEventListener(
      'message',
      handleServiceWorkerMessage,
    );

    // Check for waiting service worker
    if (registration.waiting) {
      console.log('[ServiceWorkerManager] Service worker waiting to activate');
    }

    // Check for active service worker
    if (registration.active) {
      console.log('[ServiceWorkerManager] Service worker active');
      // Ping to verify communication
      sendMessage({ type: 'PING' });
    }

    return true;
  } catch (error) {
    console.error(
      '[ServiceWorkerManager] Failed to register service worker:',
      error,
    );
    return false;
  }
}

/**
 * Starts periodic background sync
 */
export async function startPeriodicSync(config: {
  userPubkey?: PubkeyHex;
  followedPubkeys?: PubkeyHex[];
  syncGlobal?: boolean;
}): Promise<void> {
  if (!serviceWorkerRegistration) {
    // Expected in the native shell, where registration is skipped by design.
    if (!isNativeRuntime()) {
      console.warn('[ServiceWorkerManager] No service worker registered');
    }
    return;
  }

  syncConfig = config;

  // Send sync config to service worker
  await sendMessage({
    type: 'START_PERIODIC_SYNC',
    payload: config,
  });

  console.log('[ServiceWorkerManager] Started periodic sync');
}

/**
 * Stops periodic background sync
 */
export async function stopPeriodicSync(): Promise<void> {
  if (!serviceWorkerRegistration) {
    return;
  }

  syncConfig = null;

  await sendMessage({
    type: 'STOP_PERIODIC_SYNC',
  });

  console.log('[ServiceWorkerManager] Stopped periodic sync');
}

/**
 * Sends a message to the service worker
 */
function sendMessage(message: any): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!serviceWorkerRegistration?.active) {
      reject(new Error('No active service worker'));
      return;
    }

    const messageChannel = new MessageChannel();

    messageChannel.port1.onmessage = (event) => {
      resolve(event.data);
    };

    serviceWorkerRegistration.active.postMessage(message, [
      messageChannel.port2,
    ]);
  });
}

/**
 * Handles messages from the service worker
 */
function handleServiceWorkerMessage(event: MessageEvent): void {
  console.log(
    '[ServiceWorkerManager] Message from service worker:',
    event.data,
  );

  const { type, payload } = event.data;

  if (type === 'NEW_EVENTS') {
    // Dispatch custom event for the app to handle
    window.dispatchEvent(
      new CustomEvent('sw-new-events', {
        detail: {
          timelineType: event.data.timelineType,
          count: event.data.count,
        },
      }),
    );
  } else if (type === 'PONG') {
    console.log(
      '[ServiceWorkerManager] Pong received, version:',
      event.data.version,
    );
  } else if (type === 'SYNC_RESULT') {
    console.log('[ServiceWorkerManager] Sync result:', payload);
  }
}

/**
 * Checks if service workers are supported and usable in this runtime
 */
export function isServiceWorkerSupported(): boolean {
  return !isNativeRuntime() && 'serviceWorker' in navigator;
}

/**
 * Gets the current service worker registration
 */
export function getServiceWorkerRegistration(): ServiceWorkerRegistration | null {
  return serviceWorkerRegistration;
}

/**
 * Unregisters the service worker
 */
export async function unregisterServiceWorker(): Promise<boolean> {
  if (!serviceWorkerRegistration) {
    return false;
  }

  try {
    const success = await serviceWorkerRegistration.unregister();
    if (success) {
      serviceWorkerRegistration = null;
      syncConfig = null;
      console.log('[ServiceWorkerManager] Service worker unregistered');
    }
    return success;
  } catch (error) {
    console.error(
      '[ServiceWorkerManager] Failed to unregister service worker:',
      error,
    );
    return false;
  }
}

/**
 * Gets the current sync configuration
 */
export function getSyncConfig(): {
  userPubkey?: PubkeyHex;
  followedPubkeys?: PubkeyHex[];
  syncGlobal?: boolean;
} | null {
  return syncConfig;
}

// Export as default object for convenience
export const serviceWorkerManager: ServiceWorkerManager = {
  register: registerServiceWorker,
  startPeriodicSync,
  stopPeriodicSync,
  isSupported: isServiceWorkerSupported,
  getRegistration: getServiceWorkerRegistration,
};
