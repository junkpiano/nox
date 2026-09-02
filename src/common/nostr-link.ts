/**
 * What a link into the app is pointing at.
 *
 * A Nostr identifier arrives in several wrappers - a `nostr:` URI from
 * another client, a `web+nostr:` one from a browser, a link to nox.garden,
 * the app's own scheme, or the bare bech32 string pasted somewhere - and in
 * several shapes: a person (`npub`, `nprofile`), a note (`note`, `nevent`),
 * or a tag. Every one of them ends up on one of three screens, so the
 * unwrapping is done once here and both apps ask the same function.
 *
 * Anything else - an address (`naddr`), a relay (`nrelay`), a path the app
 * does not have - is null rather than a guess, and the caller opens its
 * front door.
 */

import { nip19 } from 'nostr-tools';
import type { PubkeyHex } from '../../types/nostr';

export type NostrLinkTarget =
  | { kind: 'profile'; pubkey: PubkeyHex }
  | { kind: 'event'; eventId: string; relays: string[] }
  | { kind: 'hashtag'; tag: string };

/** Hosts whose paths are this app's own routes. */
const OWN_HOSTS: ReadonlySet<string> = new Set([
  'nox.garden',
  'www.nox.garden',
]);

/**
 * The identifier inside whatever wrapper it came in, or null.
 *
 * `nostr:npub1…`, `web+nostr:npub1…`, `nox://npub1…`, `nox:npub1…`,
 * `https://nox.garden/npub1…`, `https://nox.garden/t/tag` and bare
 * `npub1…` all reduce to a path segment; the segment is then read as bech32
 * or, under `/t/`, as a tag.
 */
export function resolveNostrLink(input: string): NostrLinkTarget | null {
  const raw: string = input.trim();
  if (!raw) return null;

  const path: string | null = pathOf(raw);
  if (path === null) return null;

  const segments: string[] = path
    .split('/')
    .map((segment: string): string => safeDecode(segment).trim())
    .filter((segment: string): boolean => segment.length > 0);

  if (segments[0] === 't' && segments[1]) {
    return hashtagTarget(segments[1]);
  }
  if (segments.length === 0) return null;
  const first: string = segments[0] as string;
  if (first.startsWith('#')) return hashtagTarget(first.slice(1));
  return decodeBech32(first);
}

function hashtagTarget(tag: string): NostrLinkTarget | null {
  const clean: string = tag.trim().replace(/^#/, '').toLowerCase();
  return clean && /^[\p{L}\p{N}_-]+$/u.test(clean)
    ? { kind: 'hashtag', tag: clean }
    : null;
}

/** The part of the link that names something, with the wrapper removed. */
function pathOf(raw: string): string | null {
  const lower: string = raw.toLowerCase();
  for (const prefix of ['web+nostr:', 'nostr:', 'nox://', 'nox:']) {
    if (lower.startsWith(prefix)) {
      return raw.slice(prefix.length).replace(/^\/+/, '');
    }
  }
  if (lower.startsWith('https://') || lower.startsWith('http://')) {
    try {
      const url: URL = new URL(raw);
      if (!OWN_HOSTS.has(url.hostname.toLowerCase())) return null;
      return url.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }
  // Bare, the way it is pasted.
  return raw.replace(/^\/+/, '');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function decodeBech32(value: string): NostrLinkTarget | null {
  // bech32 is case-insensitive but all one case; other clients upper-case it
  // in QR codes.
  const text: string = value.toLowerCase();
  if (!/^(npub|nprofile|note|nevent)1[02-9ac-hj-np-z]+$/.test(text)) {
    return null;
  }
  try {
    const decoded = nip19.decode(text);
    switch (decoded.type) {
      case 'npub':
        return { kind: 'profile', pubkey: decoded.data as PubkeyHex };
      case 'nprofile':
        return {
          kind: 'profile',
          pubkey: decoded.data.pubkey as PubkeyHex,
        };
      case 'note':
        return { kind: 'event', eventId: decoded.data, relays: [] };
      case 'nevent':
        return {
          kind: 'event',
          eventId: decoded.data.id,
          relays: (decoded.data.relays ?? []).filter((relay: string): boolean =>
            /^wss?:\/\//i.test(relay),
          ),
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
