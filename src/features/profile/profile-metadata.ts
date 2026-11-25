import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import {
  newestOf,
  queryRelaysDetailed,
  type SubscriptionOpener,
} from '../../common/relay-query.js';

/*
 * Your own profile (kind 0), edited without losing what was not edited.
 *
 * A kind 0 replaces the whole profile on every relay that accepts it, so
 * anything an editor leaves out is deleted for everyone: unknown fields and
 * the event's tags are carried over, and the base is the newest copy on
 * every relay rather than whatever was cached. Spec:
 * docs/features/edit-profile/spec.md.
 */

/** The fields an editor offers; the web editor's, in its order. */
export const EDITABLE_PROFILE_FIELDS = [
  'display_name',
  'name',
  'about',
  'picture',
  'banner',
  'website',
  'nip05',
  'lud16',
] as const;
export type EditableProfileField = (typeof EDITABLE_PROFILE_FIELDS)[number];
export type ProfileEdits = Partial<Record<EditableProfileField, string>>;

/**
 * Represents the content of the newest kind 0 event found across relays.
 * The content object keeps all keys, whether known or not.
 */
export interface OwnMetadata {
  /** The newest kind 0's content, every key kept, known or not. */
  content: Record<string, unknown>;
  /** That event's tags, unchanged. */
  tags: string[][];
  /** That event's created_at, or null when there was none. */
  createdAt: number | null;
}

/**
 * Error thrown when the content of a profile event cannot be parsed as a plain object.
 */
export class UnreadableMetadataError extends Error {
  name = 'UnreadableMetadataError';
}

/**
 * Thrown when some relay did not answer. The one that stayed silent may hold
 * the newest profile - or the only one - and an edit published on top of
 * what the others said would replace it everywhere.
 */
export class NotEveryRelayAnsweredError extends Error {
  constructor(answered: number, asked: number) {
    super(`Only ${answered} of your ${asked} relays answered`);
    this.name = 'NotEveryRelayAnsweredError';
  }
}

/**
 * The newest kind 0 for `pubkey`, as every one of `relays` has it.
 *
 * Every relay, not the first few: a relay that has not answered may hold the
 * newest copy. One that never answers makes this throw rather than guess.
 */
export async function readOwnMetadata(
  relays: string[],
  pubkey: PubkeyHex,
  open?: SubscriptionOpener,
): Promise<OwnMetadata> {
  const asked: number = new Set(relays).size;
  const result = await queryRelaysDetailed(
    [...new Set(relays)],
    { kinds: [0], authors: [pubkey] },
    open,
    { everyRelay: true },
  );

  if (asked === 0 || result.answered < asked) {
    throw new NotEveryRelayAnsweredError(result.answered, asked);
  }

  const newest = newestOf(
    result.events.filter((e) => e.kind === 0 && e.pubkey === pubkey),
  );

  if (!newest) {
    return { content: {}, tags: [], createdAt: null };
  }

  try {
    const parsed = JSON.parse(newest.content);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('Content is not a plain object');
    }
    return {
      content: parsed as Record<string, unknown>,
      tags: newest.tags.map((t) => [...t]),
      createdAt: newest.created_at,
    };
  } catch (_e) {
    throw new UnreadableMetadataError('Your current profile could not be read');
  }
}

/**
 * Applies edits to a profile content object, trimming values and handling website/url sync.
 * The original content is not mutated.
 */
export function applyProfileEdits(
  content: Record<string, unknown>,
  edits: ProfileEdits,
): Record<string, unknown> {
  const next = { ...content };

  for (const field of EDITABLE_PROFILE_FIELDS) {
    if (field in edits) {
      const trimmed = (edits[field] || '').trim();
      if (trimmed.length > 0) {
        next[field] = trimmed;
      } else {
        delete next[field];
      }
    }
  }

  // Handle website/url sync
  if ('website' in edits) {
    if ((edits.website || '').trim().length > 0) {
      next.url = next.website;
    } else {
      delete next.url;
    }
  }

  return next;
}

/**
 * Creates a kind 0 draft event from profile content, including timestamp logic.
 */
export function profileMetadataDraft(
  pubkey: PubkeyHex,
  content: Record<string, unknown>,
  tags: string[][],
  previousCreatedAt: number | null,
  now: number = Math.floor(Date.now() / 1000),
): Omit<NostrEvent, 'id' | 'sig'> {
  const created_at =
    previousCreatedAt !== null && now <= previousCreatedAt
      ? previousCreatedAt + 1
      : now;

  return {
    kind: 0,
    pubkey: pubkey,
    created_at: created_at,
    tags: tags.map((t) => [...t]),
    content: JSON.stringify(content),
  };
}
