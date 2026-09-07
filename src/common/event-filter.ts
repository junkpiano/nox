/**
 * Whether an event a relay sent is one the app asked for, and genuine.
 *
 * A relay answers a REQ with whatever it likes. Nothing forces the events
 * to match the filter, and nothing forces them to be signed by the key they
 * name. Everything downstream - the zap sheet picking a payment address,
 * the timeline showing a post as someone's - assumes both, so both are
 * checked here, once, where the events come in.
 *
 * The filter check covers what NIP-01 defines: `ids`, `authors`, `kinds`,
 * `since`, `until`, and single-letter tag filters (`#e`, `#p`, ...). `ids`
 * and `authors` are prefix matches, as the spec allows. A filter key this
 * does not know is ignored rather than failing everything.
 */

import { getEventHash, verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr';

/**
 * Events whose signature has been checked, by id.
 *
 * Every query fans out to every relay, so the same event arrives several
 * times as several objects, and a signature check is the most expensive
 * thing the app does on a phone. An id is the hash of the content, so an
 * event whose id both matches its own content and is in here carries a
 * signature that was already checked against exactly this content. The
 * hash is recomputed each time - cheap - so a forgery cannot borrow an
 * id it did not earn.
 */
const verified: Set<string> = new Set();

/** Ids remembered. Old ones go when it fills; they are simply re-checked. */
const MAX_VERIFIED: number = 5000;

function rememberVerified(id: string): void {
  if (verified.size >= MAX_VERIFIED) {
    const oldest: string | undefined = verified.values().next().value;
    if (oldest !== undefined) verified.delete(oldest);
  }
  verified.add(id);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown): boolean => typeof item === 'string')
  );
}

/** The shape of an event, before anything is believed about it. */
function wellFormed(event: unknown): event is NostrEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.pubkey === 'string' &&
    typeof e.sig === 'string' &&
    typeof e.kind === 'number' &&
    typeof e.created_at === 'number' &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every(isStringArray)
  );
}

function prefixed(values: unknown, value: string): boolean {
  if (!isStringArray(values)) return true;
  return values.some((prefix: string): boolean => value.startsWith(prefix));
}

/** Whether the event is one the filter asked for. */
export function matchesFilter(
  filter: Record<string, unknown>,
  event: NostrEvent,
): boolean {
  if (!prefixed(filter.ids, event.id)) return false;
  if (!prefixed(filter.authors, event.pubkey)) return false;
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (typeof filter.since === 'number' && event.created_at < filter.since) {
    return false;
  }
  if (typeof filter.until === 'number' && event.created_at > filter.until) {
    return false;
  }
  for (const [key, wanted] of Object.entries(filter)) {
    if (key.length !== 2 || key[0] !== '#' || !isStringArray(wanted)) continue;
    const name: string = key.slice(1);
    const has: boolean = event.tags.some(
      (tag: string[]): boolean =>
        tag[0] === name && tag[1] !== undefined && wanted.includes(tag[1]),
    );
    if (!has) return false;
  }
  return true;
}

/**
 * The event, if it may be let through: well formed, an answer to the
 * question that was asked, and genuinely signed by the key it names.
 *
 * Returns a plain copy of exactly the fields that were checked, and that
 * copy is what the caller should pass on. An object from a relay is
 * ordinarily JSON, but one built in this process can carry a prototype,
 * a getter, or nostr-tools' own "already verified" mark, and then what
 * was checked and what is used need not be the same thing.
 */
export function verifiedEvent(
  filter: Record<string, unknown>,
  event: unknown,
): NostrEvent | null {
  if (!wellFormed(event)) return null;
  if (!matchesFilter(filter, event)) return null;

  // Read once, into an object of its own: nothing inherited, no getters,
  // and no mark claiming this has already been checked.
  const plain: NostrEvent = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag: string[]): string[] => [...tag]),
    content: event.content,
    sig: event.sig,
  } as NostrEvent;

  try {
    // An id is the hash of the signed fields. An event whose id is not
    // that hash is refused before anything else is considered: it is the
    // check that makes remembering an id sound at all.
    if (getEventHash(plain) !== plain.id) return null;
    // The same event from a second relay is a second object, and
    // nostr-tools remembers its work per object rather than per event.
    // The id having just been confirmed as this content's hash, a
    // remembered id is a signature already checked against this content.
    if (verified.has(plain.id)) return plain;
    if (!verifyEvent(plain)) return null;
    rememberVerified(plain.id);
    return plain;
  } catch {
    return null;
  }
}

/** Whether an event may be let through. Prefer `verifiedEvent`. */
export function acceptsEvent(
  filter: Record<string, unknown>,
  event: unknown,
): event is NostrEvent {
  return verifiedEvent(filter, event) !== null;
}
