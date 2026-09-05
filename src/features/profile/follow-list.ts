/**
 * Editing a follow list without destroying it.
 *
 * A kind 3 is not a delta. Publishing one replaces the whole contact list
 * everywhere, so a client that builds the tags from an incomplete picture does
 * not fail - it succeeds at wiping someone's follows across every relay that
 * accepts it.
 *
 * That makes this a few lines of arithmetic guarding a destructive operation,
 * which is exactly the shape of thing that must not be reimplemented per
 * platform. It was extracted from the web app's follow button so the phone
 * follows the same rules, and so both can be tested.
 *
 * The rules, in order of how badly each would hurt to get wrong:
 *
 * 1. **Nobody answering means stop.** An unreachable relay set looks identical
 *    to an empty list from the outside, and only one of those is safe to
 *    publish over. The caller says which it is; a list that is genuinely
 *    absent - a new account - is allowed to create its first one.
 * 2. **Existing tags are preserved as they are.** A `p` tag may carry a relay
 *    hint and a petname after the pubkey; rebuilding it as `['p', pubkey]`
 *    silently deletes both.
 * 3. **Non-`p` tags are left alone.** Nothing here understands them, and not
 *    understanding a tag is not a reason to drop it.
 * 4. **`content` is carried over untouched.** Some clients still keep a relay
 *    list in there as JSON.
 */

import type { NostrEvent, PubkeyHex } from '../../../types/nostr';

export class UnknownFollowListError extends Error {
  constructor() {
    super(
      'Could not load your current follow list from any relay; not modifying ' +
        'it to avoid wiping your follows.',
    );
  }
}

/** What the relays said, from {@link lookupFollowList}. */
export interface FollowListState {
  event: NostrEvent | null;
  /** At least one relay answered, so an absent list is genuinely absent. */
  answered: boolean;
}

export function isFollowing(
  current: NostrEvent | null,
  target: PubkeyHex,
): boolean {
  if (!current) {
    return false;
  }
  return current.tags.some(
    (tag: string[]): boolean => tag[0] === 'p' && tag[1] === target,
  );
}

/**
 * The tags a new kind 3 should carry after following or unfollowing someone.
 *
 * Throws rather than returning a best guess when the current list is unknown,
 * because the caller's next move is to publish, and a wrong answer here is not
 * recoverable by the person it happens to.
 */
export function nextFollowListTags(
  state: FollowListState,
  target: PubkeyHex,
  follow: boolean,
): string[][] {
  if (!state.answered) {
    throw new UnknownFollowListError();
  }

  // Answered, and there is genuinely no list: a new account following its
  // first person. Refusing here would leave such an account unable to ever
  // follow anyone, which is what happened before this was distinguished.
  const existing: string[][] = state.event ? state.event.tags : [];

  if (!follow && !state.event) {
    return [];
  }

  if (!follow) {
    // Drop only this person's `p` tag. Everything else - other follows with
    // their petnames, and any tag this client does not recognise - survives.
    return existing.filter(
      (tag: string[]): boolean => !(tag[0] === 'p' && tag[1] === target),
    );
  }

  if (isFollowing(state.event, target)) {
    // Already there. Returning the list unchanged keeps whatever relay hint or
    // petname it already carries, which re-adding would flatten.
    return existing;
  }

  return [...existing, ['p', target]];
}
