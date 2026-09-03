import { createRelayWebSocket } from '../../common/relay-socket.js';
import { signWithSession } from '../../common/signer.js';
import { normalizeRelayUrl, recordRelayFailure } from './relays.js';

// Local structural types to avoid module-resolution edge cases with `types/nostr`.
// This stays compatible with the app-wide `NostrEvent` interface.
type PubkeyHex = string;
type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

const NIP65_KIND_RELAY_LIST: number = 10002;

function uniqPreserveOrder(values: string[]): string[] {
  const seen: Set<string> = new Set();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function parseNip65RelayUrls(tags: string[][]): string[] {
  const urls: string[] = [];
  for (const tag of tags) {
    if (!Array.isArray(tag)) continue;
    if (tag[0] !== 'r') continue;
    const rawUrl: string | undefined = tag[1];
    if (!rawUrl) continue;
    const normalized: string | null = normalizeRelayUrl(rawUrl);
    if (normalized) {
      urls.push(normalized);
    }
  }
  return uniqPreserveOrder(urls);
}

export function buildNip65RelayTags(relayUrls: string[]): string[][] {
  return uniqPreserveOrder(relayUrls)
    .map((url: string): string | null => normalizeRelayUrl(url))
    .filter((url: string | null): url is string => Boolean(url))
    .map((url: string): string[] => ['r', url]);
}

export async function fetchNip65RelayList(params: {
  pubkeyHex: PubkeyHex;
  relays: string[];
  timeoutMs?: number;
}): Promise<{ relayUrls: string[]; createdAt: number } | null> {
  const timeoutMs: number = Number.isFinite(params.timeoutMs)
    ? Math.max(500, Math.floor(params.timeoutMs as number))
    : 5000;

  let newestEvent: NostrEvent | null = null;

  const promises: Promise<void>[] = params.relays.map(
    async (relayUrl: string): Promise<void> => {
      try {
        const socket: WebSocket = createRelayWebSocket(relayUrl);
        await new Promise<void>((resolve) => {
          let settled: boolean = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.close();
            resolve();
          };

          const timeout = setTimeout((): void => {
            recordRelayFailure(relayUrl);
            finish();
          }, timeoutMs);

          socket.onopen = (): void => {
            const subId: string = `nip65-${Math.random().toString(36).slice(2)}`;
            const req: [
              string,
              string,
              { kinds: number[]; authors: string[]; limit: number },
            ] = [
              'REQ',
              subId,
              {
                kinds: [NIP65_KIND_RELAY_LIST],
                authors: [params.pubkeyHex],
                limit: 10,
              },
            ];
            socket.send(JSON.stringify(req));
          };

          socket.onmessage = (msg: MessageEvent): void => {
            const arr: any[] = JSON.parse(msg.data);
            if (arr[0] === 'EVENT' && arr[2]?.kind === NIP65_KIND_RELAY_LIST) {
              const event: NostrEvent = arr[2] as NostrEvent;
              if (!newestEvent || event.created_at >= newestEvent.created_at) {
                newestEvent = event;
              }
              return;
            }
            if (arr[0] === 'EOSE') {
              finish();
            }
          };

          socket.onerror = (): void => {
            finish();
          };
        });
      } catch (error: unknown) {
        console.warn(
          `[NIP-65] Failed to fetch relay list from ${relayUrl}:`,
          error,
        );
      }
    },
  );

  await Promise.allSettled(promises);

  // Copy to a local const before narrowing; `newestEvent` is written from socket callbacks.
  const resolved: NostrEvent | null = newestEvent;

  if (resolved === null) {
    return null;
  }

  // TS sometimes fails to narrow this in strict+isolatedModules setups when the value
  // is populated from nested socket callbacks; keep it runtime-safe instead.
  const eventAny: any = resolved;
  const relayUrls: string[] = parseNip65RelayUrls(
    Array.isArray(eventAny?.tags) ? (eventAny.tags as string[][]) : [],
  );
  const createdAt: number =
    typeof eventAny?.created_at === 'number' ? eventAny.created_at : 0;
  return { relayUrls, createdAt };
}

export async function signNip65RelayListEvent(params: {
  pubkeyHex: PubkeyHex;
  relayUrls: string[];
}): Promise<NostrEvent> {
  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
    kind: NIP65_KIND_RELAY_LIST,
    pubkey: params.pubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: buildNip65RelayTags(params.relayUrls),
    content: '',
  };

  return signWithSession(unsignedEvent);
}
