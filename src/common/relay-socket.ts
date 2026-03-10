import { finalizeEvent } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr';
import {
  getRelays,
  normalizeRelayUrl,
  recordRelayFailure,
  recordRelaySuccess,
} from '../features/relays/relays.js';
import { getSessionPrivateKey } from './session.js';

const RELAY_AUTH_PERMISSIONS_KEY: string = 'nostr_relay_auth_permissions_v1';
const SHARED_RELAY_CONNECT_TIMEOUT_MS: number = 5000;

type RelayAuthPermission = 'allow' | 'deny';

interface RelayAuthPermissions {
  [relayUrl: string]: RelayAuthPermission;
}

interface AuthChallengeMessage {
  type: 'AUTH';
  challenge: string;
}

interface SharedRelaySubscription {
  onEvent?: ((event: NostrEvent) => void) | undefined;
  onEose?: (() => void) | undefined;
  onClosed?: ((reason: string) => void) | undefined;
}

interface SharedRelayConnection {
  relayUrl: string;
  socket: WebSocket | null;
  openPromise: Promise<WebSocket> | null;
  subscriptions: Map<string, SharedRelaySubscription>;
}

const sharedRelayConnections: Map<string, SharedRelayConnection> = new Map();

interface WindowWithNostr extends Window {
  nostr?: {
    signEvent: (event: {
      kind: number;
      created_at: number;
      tags: string[][];
      content: string;
    }) => Promise<NostrEvent>;
  };
}

function loadRelayAuthPermissions(): RelayAuthPermissions {
  try {
    const raw: string | null = localStorage.getItem(RELAY_AUTH_PERMISSIONS_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const permissions: RelayAuthPermissions = {};
    Object.entries(parsed as Record<string, unknown>).forEach(
      ([relayUrl, value]: [string, unknown]): void => {
        if (value === 'allow' || value === 'deny') {
          permissions[relayUrl] = value;
        }
      },
    );
    return permissions;
  } catch {
    return {};
  }
}

function persistRelayAuthPermissions(permissions: RelayAuthPermissions): void {
  try {
    localStorage.setItem(
      RELAY_AUTH_PERMISSIONS_KEY,
      JSON.stringify(permissions),
    );
  } catch (error: unknown) {
    console.warn('Failed to persist relay auth permissions:', error);
  }
}

function getRelayAuthPermission(relayUrl: string): RelayAuthPermission | null {
  const permissions: RelayAuthPermissions = loadRelayAuthPermissions();
  return permissions[relayUrl] || null;
}

function setRelayAuthPermissionForRelays(
  relayUrls: string[],
  permission: RelayAuthPermission,
): void {
  const permissions: RelayAuthPermissions = loadRelayAuthPermissions();
  relayUrls.forEach((relayUrl: string): void => {
    const normalizedRelayUrl: string | null = normalizeRelayUrl(relayUrl);
    const targetRelayUrl: string = normalizedRelayUrl || relayUrl;
    permissions[targetRelayUrl] = permission;
  });
  persistRelayAuthPermissions(permissions);
}

function getConfiguredRelayUrls(): string[] {
  return getRelays()
    .map((relayUrl: string): string | null => normalizeRelayUrl(relayUrl))
    .filter((relayUrl: string | null): relayUrl is string => Boolean(relayUrl));
}

function parseAuthChallengeMessage(data: string): AuthChallengeMessage | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      return null;
    }
    if (parsed[0] !== 'AUTH' || typeof parsed[1] !== 'string') {
      return null;
    }
    return {
      type: 'AUTH',
      challenge: parsed[1],
    };
  } catch {
    return null;
  }
}

async function signRelayAuthEvent(
  relayUrl: string,
  challenge: string,
): Promise<NostrEvent | null> {
  const unsignedEvent: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  } = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relay', relayUrl],
      ['challenge', challenge],
    ],
    content: '',
  };

  if (typeof window !== 'undefined') {
    const nostr: WindowWithNostr['nostr'] = (window as WindowWithNostr).nostr;
    if (nostr?.signEvent) {
      return await nostr.signEvent(unsignedEvent);
    }
  }

  const privateKey: Uint8Array | null = getSessionPrivateKey();
  if (!privateKey) {
    return null;
  }
  return finalizeEvent(unsignedEvent, privateKey);
}

function canSignRelayAuthEvent(): boolean {
  if (typeof window !== 'undefined') {
    const nostr: WindowWithNostr['nostr'] = (window as WindowWithNostr).nostr;
    if (nostr?.signEvent) {
      return true;
    }
  }
  return Boolean(getSessionPrivateKey());
}

function ensureRelayAuthAllowed(relayUrl: string): boolean {
  const existingPermission: RelayAuthPermission | null =
    getRelayAuthPermission(relayUrl);
  if (existingPermission === 'allow') {
    return true;
  }
  if (existingPermission === 'deny') {
    return false;
  }

  const configuredRelayUrls: string[] = getConfiguredRelayUrls();
  if (!configuredRelayUrls.includes(relayUrl)) {
    // Do not prompt for ad-hoc relay hints; only configured relays can request consent.
    return false;
  }

  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    return false;
  }

  const allowed: boolean = window.confirm(
    `Relay authentication is required.\n\nAllow signing auth challenges for all configured relays?`,
  );
  setRelayAuthPermissionForRelays(
    configuredRelayUrls,
    allowed ? 'allow' : 'deny',
  );
  return allowed;
}

async function handleRelayAuthChallenge(
  socket: WebSocket,
  relayUrl: string,
  challenge: string,
): Promise<void> {
  if (!canSignRelayAuthEvent()) {
    return;
  }
  if (!ensureRelayAuthAllowed(relayUrl)) {
    return;
  }

  try {
    const signedEvent: NostrEvent | null = await signRelayAuthEvent(
      relayUrl,
      challenge,
    );
    if (!signedEvent) {
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(['AUTH', signedEvent]));
  } catch (error: unknown) {
    console.warn(
      `Failed to respond to auth challenge from ${relayUrl}:`,
      error,
    );
  }
}

export function createRelayWebSocket(
  relayUrl: string,
  trackHealth: boolean = true,
): WebSocket {
  const socket: WebSocket = new WebSocket(relayUrl);
  const relayUrlForAuth: string = normalizeRelayUrl(relayUrl) || relayUrl;
  const handledChallenges: Set<string> = new Set();

  socket.addEventListener('message', (event: MessageEvent): void => {
    if (typeof event.data !== 'string') {
      return;
    }
    const authMessage: AuthChallengeMessage | null = parseAuthChallengeMessage(
      event.data,
    );
    if (!authMessage || authMessage.type !== 'AUTH') {
      return;
    }
    if (handledChallenges.has(authMessage.challenge)) {
      return;
    }
    handledChallenges.add(authMessage.challenge);
    void handleRelayAuthChallenge(
      socket,
      relayUrlForAuth,
      authMessage.challenge,
    );
  });

  if (trackHealth) {
    socket.addEventListener('open', (): void => {
      recordRelaySuccess(relayUrl);
    });
    socket.addEventListener('error', (): void => {
      recordRelayFailure(relayUrl);
    });
  }
  return socket;
}

function getSharedRelayConnection(relayUrl: string): SharedRelayConnection {
  const normalizedRelayUrl: string = normalizeRelayUrl(relayUrl) || relayUrl;
  const existing: SharedRelayConnection | undefined =
    sharedRelayConnections.get(normalizedRelayUrl);
  if (existing) {
    return existing;
  }

  const connection: SharedRelayConnection = {
    relayUrl: normalizedRelayUrl,
    socket: null,
    openPromise: null,
    subscriptions: new Map(),
  };
  sharedRelayConnections.set(normalizedRelayUrl, connection);
  return connection;
}

function cleanupSharedSubscription(
  connection: SharedRelayConnection,
  subId: string,
): void {
  connection.subscriptions.delete(subId);
  if (connection.socket?.readyState === WebSocket.OPEN) {
    connection.socket.send(JSON.stringify(['CLOSE', subId]));
  }
}

function attachSharedRelayListeners(connection: SharedRelayConnection): void {
  const socket: WebSocket | null = connection.socket;
  if (!socket) {
    return;
  }

  const handledChallenges: Set<string> = new Set();

  socket.addEventListener('message', (event: MessageEvent): void => {
    if (typeof event.data !== 'string') {
      return;
    }

    const authMessage: AuthChallengeMessage | null = parseAuthChallengeMessage(
      event.data,
    );
    if (authMessage?.type === 'AUTH') {
      if (handledChallenges.has(authMessage.challenge)) {
        return;
      }
      handledChallenges.add(authMessage.challenge);
      void handleRelayAuthChallenge(
        socket,
        connection.relayUrl,
        authMessage.challenge,
      );
      return;
    }

    let parsedMessage: unknown;
    try {
      parsedMessage = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!Array.isArray(parsedMessage)) {
      return;
    }

    const type: unknown = parsedMessage[0];
    const subId: unknown = parsedMessage[1];
    if (typeof subId !== 'string') {
      return;
    }

    const subscription: SharedRelaySubscription | undefined =
      connection.subscriptions.get(subId);
    if (!subscription) {
      return;
    }

    if (type === 'EVENT' && parsedMessage[2]) {
      subscription.onEvent?.(parsedMessage[2] as NostrEvent);
      return;
    }

    if (type === 'EOSE') {
      subscription.onEose?.();
      return;
    }

    if (type === 'CLOSED') {
      subscription.onClosed?.(
        typeof parsedMessage[2] === 'string' ? parsedMessage[2] : '',
      );
      cleanupSharedSubscription(connection, subId);
    }
  });

  socket.addEventListener('open', (): void => {
    recordRelaySuccess(connection.relayUrl);
  });

  socket.addEventListener('error', (): void => {
    recordRelayFailure(connection.relayUrl);
  });

  socket.addEventListener('close', (): void => {
    connection.socket = null;
    connection.openPromise = null;
    connection.subscriptions.clear();
  });
}

async function ensureSharedRelaySocket(
  relayUrl: string,
): Promise<SharedRelayConnection> {
  const connection: SharedRelayConnection = getSharedRelayConnection(relayUrl);
  const currentSocket: WebSocket | null = connection.socket;

  if (currentSocket?.readyState === WebSocket.OPEN) {
    return connection;
  }

  if (connection.openPromise) {
    await connection.openPromise;
    return connection;
  }

  connection.openPromise = new Promise<WebSocket>((resolve, reject) => {
    const socket: WebSocket = new WebSocket(connection.relayUrl);
    connection.socket = socket;
    attachSharedRelayListeners(connection);
    let settled: boolean = false;

    const finishResolve = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      connection.openPromise = null;
      resolve(socket);
    };

    const finishReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      connection.openPromise = null;
      reject(error);
    };

    const timeoutId = window.setTimeout((): void => {
      try {
        socket.close();
      } catch {
        // Best-effort cleanup for stalled connections.
      }
      finishReject(
        new Error(
          `Timed out connecting to relay ${connection.relayUrl}`,
        ),
      );
    }, SHARED_RELAY_CONNECT_TIMEOUT_MS);

    socket.addEventListener(
      'open',
      (): void => {
        finishResolve();
      },
      { once: true },
    );

    socket.addEventListener(
      'error',
      (): void => {
        finishReject(
          new Error(`Failed to connect to relay ${connection.relayUrl}`),
        );
      },
      { once: true },
    );

    socket.addEventListener(
      'close',
      (): void => {
        finishReject(
          new Error(`Relay ${connection.relayUrl} closed before opening`),
        );
      },
      { once: true },
    );
  });

  await connection.openPromise;
  return connection;
}

export async function openRelaySubscription(
  relayUrl: string,
  filter: Record<string, unknown>,
  subscription: SharedRelaySubscription,
): Promise<() => void> {
  const connection: SharedRelayConnection = await ensureSharedRelaySocket(
    relayUrl,
  );
  const subId: string = `sub-${Math.random().toString(36).slice(2)}`;
  connection.subscriptions.set(subId, subscription);
  connection.socket?.send(JSON.stringify(['REQ', subId, filter]));

  return (): void => {
    cleanupSharedSubscription(connection, subId);
  };
}
