import { emitAppEvent } from '../../common/app-events.js';
import { kvGet, kvSet } from '../../common/kv.js';
const RELAYS_STORAGE_KEY: string = 'nostr_relays';
const RELAY_HEALTH_KEY: string = 'nostr_relay_health_v1';
const defaultRelays: string[] = [
  'wss://relay.snort.social',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://yabu.me',
];

let relays: string[] = loadRelaysFromStorage();
const relayHealth: Map<string, { success: number; failure: number }> =
  loadRelayHealth();
relayHealth.forEach(
  (_value: { success: number; failure: number }, relayUrl: string): void => {
    if (!relays.includes(relayUrl)) {
      relayHealth.delete(relayUrl);
    }
  },
);

export function getRelays(): string[] {
  return relays;
}

export function getAllRelays(): string[] {
  return relays;
}

export function didUserConfigureRelays(): boolean {
  return kvGet(RELAYS_STORAGE_KEY) !== null;
}

export function setRelays(relayList: string[]): void {
  const unique: string[] = Array.from(new Set(relayList));
  kvSet(RELAYS_STORAGE_KEY, JSON.stringify(unique));
  relays = unique;
  relayHealth.forEach(
    (_value: { success: number; failure: number }, relayUrl: string): void => {
      if (!relays.includes(relayUrl)) {
        relayHealth.delete(relayUrl);
      }
    },
  );
  persistRelayHealth();
  notifyRelaysUpdated();
}

export function normalizeRelayUrl(rawUrl: string): string | null {
  const trimmed: string = rawUrl.trim();
  if (!trimmed) return null;

  const withScheme: string = trimmed.match(/^wss?:\/\//i)
    ? trimmed
    : `wss://${trimmed}`;
  try {
    const parsed: URL = new URL(withScheme);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return null;
    }
    let href: string = parsed.toString();
    if (href.endsWith('/') && parsed.pathname === '/') {
      href = href.slice(0, -1);
    }
    return href;
  } catch {
    return null;
  }
}

export function recordRelayFailure(relayUrl: string): void {
  const normalized: string | null = normalizeRelayUrl(relayUrl);
  const target: string = normalized || relayUrl;
  if (!relays.includes(target)) {
    return;
  }
  const current: { success: number; failure: number } = relayHealth.get(
    target,
  ) || { success: 0, failure: 0 };
  relayHealth.set(target, {
    success: current.success,
    failure: current.failure + 1,
  });
  persistRelayHealth();
  notifyRelayHealthUpdated();
}

export function recordRelaySuccess(relayUrl: string): void {
  const normalized: string | null = normalizeRelayUrl(relayUrl);
  const target: string = normalized || relayUrl;
  if (!relays.includes(target)) return;
  const current: { success: number; failure: number } = relayHealth.get(
    target,
  ) || { success: 0, failure: 0 };
  relayHealth.set(target, {
    success: current.success + 1,
    failure: current.failure,
  });
  persistRelayHealth();
  notifyRelayHealthUpdated();
}

function loadRelaysFromStorage(): string[] {
  try {
    const raw: string | null = kvGet(RELAYS_STORAGE_KEY);
    if (!raw) return [...defaultRelays];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...defaultRelays];
    const normalized: string[] = parsed
      .map((value: unknown): string | null =>
        typeof value === 'string' ? normalizeRelayUrl(value) : null,
      )
      .filter((value: string | null): value is string => Boolean(value));
    if (normalized.length === 0) return [...defaultRelays];
    return Array.from(new Set(normalized));
  } catch {
    return [...defaultRelays];
  }
}

function loadRelayHealth(): Map<string, { success: number; failure: number }> {
  try {
    const raw: string | null = kvGet(RELAY_HEALTH_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return new Map();
    const entries: Array<[string, { success: number; failure: number }]> =
      Object.entries(
        parsed as Record<string, { success: number; failure: number }>,
      )
        .map(
          ([key, value]: [string, { success: number; failure: number }]): [
            string,
            { success: number; failure: number },
          ] => {
            const success: number = Number.isFinite(value?.success)
              ? value.success
              : 0;
            const failure: number = Number.isFinite(value?.failure)
              ? value.failure
              : 0;
            return [key, { success, failure }];
          },
        )
        .filter(
          ([key]: [string, { success: number; failure: number }]): boolean =>
            typeof key === 'string',
        );
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function persistRelayHealth(): void {
  const healthObj: Record<string, { success: number; failure: number }> = {};
  relayHealth.forEach(
    (value: { success: number; failure: number }, key: string): void => {
      healthObj[key] = value;
    },
  );
  kvSet(RELAY_HEALTH_KEY, JSON.stringify(healthObj));
}

function notifyRelaysUpdated(): void {
  emitAppEvent('relays-updated');
}

function notifyRelayHealthUpdated(): void {
  emitAppEvent('relay-health-updated');
}
