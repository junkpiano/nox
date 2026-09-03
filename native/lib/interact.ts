import {
  isReadOnlySession,
  ReadOnlySessionError,
} from '../../src/common/session';
/**
 * Reacting and following: the two writes that are not a note.
 *
 * Both sign with the session key and publish through the same helper the
 * compose box uses, so a reaction carries the client tag and reaches relays by
 * the same route a post does.
 *
 * Following is the dangerous one and its rules are not written here. A kind 3
 * replaces the whole contact list on every relay that accepts it, so the
 * tag arithmetic lives in the shared `follow-list.ts` - the same code the web
 * button runs, with tests - and this file only fetches, calls it, and
 * publishes what comes back.
 */

import { finalizeEvent } from 'nostr-tools';
import { withClientTag } from '../../src/common/client-tag';
import {
  fetchLatestFollowListEvent,
  lookupFollowList,
} from '../../src/common/events-queries';
import { replyTags, repostTags } from '../../src/common/reply-tags';
import { getSessionPrivateKey } from '../../src/common/session';
import {
  isFollowing as listHasFollow,
  nextFollowListTags,
} from '../../src/features/profile/follow-list';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { NotSignedInError, type PublishResult, publishSigned } from './publish';

/**
 * NIP-25 says "+" means a like, so that is what is sent. An empty content
 * means the same thing to most clients, but saying it explicitly leaves less
 * to interpretation.
 */
const LIKE = '+';

function requireKey(): Uint8Array {
  if (isReadOnlySession()) {
    throw new ReadOnlySessionError();
  }
  const key: Uint8Array | null = getSessionPrivateKey();
  if (!key) {
    throw new NotSignedInError();
  }
  return key;
}

/**
 * Likes an event.
 *
 * The `e` tag names what is being reacted to and the `p` tag its author, which
 * is what lets the author's client show the reaction as a notification. Both
 * are required by NIP-25; omitting `p` produces a reaction nobody is told
 * about.
 */
export async function likeEvent(event: NostrEvent): Promise<PublishResult> {
  const key: Uint8Array = requireKey();

  const draft = withClientTag({
    kind: 7,
    pubkey: '',
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', event.id],
      ['p', event.pubkey],
    ] as string[][],
    content: LIKE,
  });

  const signed = finalizeEvent(
    {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
    },
    key,
  ) as unknown as NostrEvent;

  return publishSigned(signed);
}

/**
 * Replies to an event.
 *
 * The tags come from the shared `reply-tags.ts`, which carries the thread root
 * as well as the immediate parent and names everyone upstream. Emitting only
 * the parent - which is what the web overlay still does - publishes a reply
 * that no client can place in its thread and that nobody above it is told
 * about.
 */
export async function replyToEvent(
  parent: NostrEvent,
  content: string,
): Promise<PublishResult> {
  const key: Uint8Array = requireKey();

  const draft = withClientTag({
    kind: 1,
    pubkey: '',
    created_at: Math.floor(Date.now() / 1000),
    tags: replyTags(parent),
    content,
  });

  const signed = finalizeEvent(
    {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
    },
    key,
  ) as unknown as NostrEvent;

  return publishSigned(signed);
}

/**
 * Reposts an event.
 *
 * NIP-18 puts the whole original in `content` as JSON, so a client that has
 * never seen the event can still render the repost without another round trip.
 */
export async function repostEvent(target: NostrEvent): Promise<PublishResult> {
  const key: Uint8Array = requireKey();

  const draft = withClientTag({
    kind: 6,
    pubkey: '',
    created_at: Math.floor(Date.now() / 1000),
    tags: repostTags(target),
    content: JSON.stringify(target),
  });

  const signed = finalizeEvent(
    {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
    },
    key,
  ) as unknown as NostrEvent;

  return publishSigned(signed);
}

export interface FollowOutcome {
  result: PublishResult;
  /** Whether the person is followed after this. */
  following: boolean;
}

/**
 * Follows or unfollows, by editing the existing contact list.
 *
 * The current kind 3 is fetched first and, when it cannot be found,
 * `nextFollowListTags` throws rather than building a list from nothing. That
 * refusal is the whole safety of this operation: every relay failing looks
 * exactly like "you follow nobody", and publishing the second reading would
 * erase the first one everywhere.
 */
export async function setFollowing(
  viewer: PubkeyHex,
  target: PubkeyHex,
  follow: boolean,
): Promise<FollowOutcome> {
  const key: Uint8Array = requireKey();
  const relays: string[] = getRelays();

  // The lookup reports whether any relay answered, which is what separates
  // "you have no list yet" from "nobody would tell us". Only the second is a
  // reason to refuse; the first is a new account making its first list.
  // Every relay gets its say here: the list published next replaces
  // whatever the slowest relay was holding.
  const lookup = await lookupFollowList(viewer, relays, { waitForAll: true });
  const current: NostrEvent | null = lookup.event;

  // Throws UnknownFollowListError when nothing answered.
  const tags: string[][] = nextFollowListTags(lookup, target, follow);

  const signed = finalizeEvent(
    {
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      // Carried over untouched: some clients keep a relay list in here as JSON.
      content: current?.content ?? '',
    },
    key,
  ) as unknown as NostrEvent;

  return {
    result: await publishSigned(signed),
    following: follow,
  };
}

/** Whether the viewer currently follows this person, read from their kind 3. */
export async function readFollowing(
  viewer: PubkeyHex,
  target: PubkeyHex,
): Promise<boolean> {
  const current: NostrEvent | null = await fetchLatestFollowListEvent(
    viewer,
    getRelays(),
  );
  return listHasFollow(current, target);
}

export { NotSignedInError };
export { requestDeletion } from '../../src/common/delete-event';
export { UnknownFollowListError } from '../../src/features/profile/follow-list';
