/**
 * NIP-38 user status: the line someone puts under their name about right now.
 *
 * The whole value of a status is that it is current, so most of this file is
 * about deciding when to stop believing one. An `expiration` tag settles it
 * when there is one. There usually is not, and nobody remembers to clear a
 * status by hand, so age settles the rest: a six month old "back in five
 * minutes" is worse than showing nothing at all.
 *
 * Only the general status is read. NIP-38 also describes a `music` one, which
 * is a different thing with a different lifetime - it means "playing now" and
 * is stale in minutes rather than days - and mixing them under one line would
 * make both wrong.
 */

import { finalizeEvent } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import { getSessionPrivateKey } from '../../common/session.js';

export const USER_STATUS_KIND: number = 30315;

/** The status this reads. NIP-38 also defines `music`, deliberately not read. */
const GENERAL: string = 'general';

/**
 * How long a status without an expiration is believed.
 *
 * Long enough that "on holiday until Friday" survives the week, short enough
 * that an abandoned status stops speaking for someone. There is nothing in the
 * NIP to derive this from; it is a judgement about how people use the field.
 */
const STALE_AFTER_SECONDS: number = 7 * 86_400;

/** One line under a name has room for a sentence, not a paragraph. */
const MAX_TEXT_LENGTH: number = 140;

/**
 * The shape a status is stored in, before signing.
 *
 * Separate from publishing so the decisions - which `d`, whether an
 * `expiration`, what empty means - can be read and tested without a relay or a
 * key in the room.
 */
export function buildUserStatusEvent(params: {
  pubkeyHex: PubkeyHex;
  text: string;
  expiresInSeconds: number | null;
  now: number;
}): Omit<NostrEvent, 'id' | 'sig'> {
  const tags: string[][] = [['d', GENERAL]];
  if (params.expiresInSeconds !== null) {
    // Absolute, because a reader compares it against its own clock and has no
    // way to know when a duration started.
    tags.push(['expiration', String(params.now + params.expiresInSeconds)]);
  }

  return {
    kind: USER_STATUS_KIND,
    pubkey: params.pubkeyHex,
    created_at: params.now,
    tags,
    // Held to the same shape this client imposes on everyone else's status.
    // Publishing something nox would refuse to display would be strange.
    content: flatten(params.text).slice(0, MAX_TEXT_LENGTH),
  };
}

export interface UserStatus {
  text: string;
  /** A link the author attached, when they attached one worth following. */
  url: string | null;
}

function firstTagValue(event: NostrEvent, name: string): string | null {
  const tag: string[] | undefined = event.tags.find(
    (candidate: string[]): boolean => candidate[0] === name,
  );
  const value: unknown = tag?.[1];
  return typeof value === 'string' ? value : null;
}

/**
 * Collapses whitespace and drops control characters.
 *
 * The status sits on one line under a name, so a newline or a tab in it is
 * either a mistake or an attempt to take more room than the line. Written by
 * whoever published the event, so it is not trusted to be either short or
 * single-line.
 */
function flatten(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Only a link a browser should follow. */
function readLink(event: NostrEvent): string | null {
  const raw: string | null = firstTagValue(event, 'r');
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Returns the status worth showing, or null.
 *
 * `now` is passed in rather than read, so the staleness rule can be tested
 * without waiting a week.
 */
export function parseUserStatus(
  event: NostrEvent,
  now: number,
): UserStatus | null {
  if (event.kind !== USER_STATUS_KIND) {
    return null;
  }
  if (firstTagValue(event, 'd') !== GENERAL) {
    return null;
  }

  const expiration: string | null = firstTagValue(event, 'expiration');
  if (expiration !== null) {
    const expiresAt: number = Number.parseInt(expiration, 10);
    // An unreadable expiration is treated as expired: the author meant this to
    // stop being shown at some point, and we cannot tell when.
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return null;
    }
  } else if (now - event.created_at > STALE_AFTER_SECONDS) {
    return null;
  }

  // Clearing a status is publishing an empty one, so this is how a status
  // normally ends rather than a malformed event.
  const text: string = flatten(event.content).slice(0, MAX_TEXT_LENGTH);
  if (!text) {
    return null;
  }

  return { text, url: readLink(event) };
}

/**
 * Reads someone's current status off the relays.
 *
 * Returns null when they have none, when theirs has expired, and when the
 * lookup fails - all of which render the same way, which is not at all. A
 * status is decoration on a profile; a failure to fetch one is not worth
 * telling anyone about.
 *
 * The `#d` filter asks relays for the general status only. Relays that ignore
 * it send both, and `parseUserStatus` drops the music one.
 */
export async function fetchUserStatus(params: {
  pubkeyHex: PubkeyHex;
  relays: string[];
  timeoutMs?: number;
}): Promise<UserStatus | null> {
  const statuses = await fetchUserStatuses({
    pubkeys: [params.pubkeyHex],
    relays: params.relays,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  });
  return statuses.get(params.pubkeyHex) ?? null;
}

/**
 * Reads statuses for a whole timeline at once.
 *
 * A Nostr filter takes a list of authors, so everyone visible costs one
 * subscription rather than one each. Per author it would have been a socket
 * round trip per card, which is the reason a timeline was not worth showing
 * these on before.
 *
 * Authors with no status, an expired one, or one this refuses to read are
 * simply absent from the map.
 */
export async function fetchUserStatuses(params: {
  pubkeys: PubkeyHex[];
  relays: string[];
  timeoutMs?: number;
}): Promise<Map<PubkeyHex, UserStatus>> {
  const authors: PubkeyHex[] = Array.from(new Set(params.pubkeys));
  const result: Map<PubkeyHex, UserStatus> = new Map();
  if (authors.length === 0 || params.relays.length === 0) {
    return result;
  }

  const timeoutMs: number = Number.isFinite(params.timeoutMs)
    ? Math.max(500, Math.floor(params.timeoutMs as number))
    : 4000;

  const newest: Map<PubkeyHex, NostrEvent> = new Map();

  await Promise.allSettled(
    params.relays.map(async (relayUrl: string): Promise<void> => {
      try {
        const socket: WebSocket = createRelayWebSocket(relayUrl);
        await new Promise<void>((resolve) => {
          let settled: boolean = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try {
              socket.close();
            } catch {
              // Already closing.
            }
            resolve();
          };
          const timeout = setTimeout(finish, timeoutMs);

          socket.onopen = (): void => {
            socket.send(
              JSON.stringify([
                'REQ',
                `status-${Math.random().toString(36).slice(2)}`,
                {
                  kinds: [USER_STATUS_KIND],
                  authors,
                  '#d': [GENERAL],
                  limit: authors.length,
                },
              ]),
            );
          };

          socket.onmessage = (msg: MessageEvent): void => {
            try {
              const frame: unknown[] = JSON.parse(msg.data);
              if (frame[0] === 'EVENT') {
                const event = frame[2] as NostrEvent;
                if (event?.kind !== USER_STATUS_KIND) {
                  return;
                }
                const author = event.pubkey as PubkeyHex;
                const held = newest.get(author);
                if (!held || event.created_at >= held.created_at) {
                  newest.set(author, event);
                }
                return;
              }
              if (frame[0] === 'EOSE') {
                finish();
              }
            } catch {
              finish();
            }
          };

          socket.onerror = finish;
        });
      } catch {
        // One unreachable relay must not fail the lookup.
      }
    }),
  );

  const now: number = Math.floor(Date.now() / 1000);
  for (const [author, event] of newest) {
    const status: UserStatus | null = parseUserStatus(event, now);
    if (status) {
      result.set(author, status);
    }
  }
  return result;
}

/**
 * Signs a status with whatever holds the key.
 *
 * An extension when there is one, the session key otherwise - the same two
 * routes every other published event takes.
 */
export async function signUserStatusEvent(params: {
  pubkeyHex: PubkeyHex;
  text: string;
  expiresInSeconds: number | null;
}): Promise<NostrEvent> {
  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = buildUserStatusEvent({
    pubkeyHex: params.pubkeyHex,
    text: params.text,
    expiresInSeconds: params.expiresInSeconds,
    now: Math.floor(Date.now() / 1000),
  });

  const extension = (
    window as unknown as {
      nostr?: {
        signEvent?: (e: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
      };
    }
  ).nostr;

  if (extension?.signEvent) {
    return extension.signEvent(unsignedEvent);
  }

  const privateKey: Uint8Array | null = getSessionPrivateKey();
  if (!privateKey) {
    throw new Error(
      'No signing method available (extension or private key required).',
    );
  }
  return finalizeEvent(unsignedEvent, privateKey) as NostrEvent;
}
