import { newestOf, queryRelays } from '../../common/relay-query.js';
import { signWithSession } from '../../common/signer.js';
import { normalizeRelayUrl } from './relays.js';

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
}): Promise<{ relayUrls: string[]; createdAt: number } | null> {
  // Through the checked ingress: this list decides which relays are asked
  // next, so it is believed only when signed by the person it is for.
  const newest: NostrEvent | null = newestOf(
    await queryRelays(params.relays, {
      kinds: [NIP65_KIND_RELAY_LIST],
      authors: [params.pubkeyHex],
      limit: 10,
    }),
  );
  if (!newest) return null;
  return {
    relayUrls: parseNip65RelayUrls(newest.tags),
    createdAt: newest.created_at,
  };
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
