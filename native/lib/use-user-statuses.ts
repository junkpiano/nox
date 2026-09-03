/**
 * NIP-38 statuses for the people on a screen.
 *
 * One book for the whole app, so a person asked about on the home timeline
 * is not asked about again on their profile, and a screen that opens shows
 * what is already known before it asks about anyone new. The shared book
 * decides who still needs asking; this only ties it to a render.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  createStatusBook,
  STATUS_ANSWER_TTL_SECONDS,
} from '../../src/common/status-book';
import type { UserStatus } from '../../src/features/profile/user-status';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';

const book = createStatusBook();

/** The statuses of these authors, filled in as the relays answer. */
export function useUserStatuses(
  posts: ReadonlyArray<{ pubkey: PubkeyHex }>,
): Map<PubkeyHex, UserStatus> {
  const [statuses, setStatuses] = useState<Map<PubkeyHex, UserStatus>>(() =>
    book.known(),
  );
  // The effect keys on the set of people, not the list: a list that only
  // reordered, or gained a second post by someone, has nobody new to ask.
  const authors: string = Array.from(
    new Set(posts.map((post): PubkeyHex => post.pubkey)),
  )
    .sort()
    .join(',');

  useEffect((): (() => void) => {
    let cancelled = false;
    if (!authors) {
      return (): void => {
        cancelled = true;
      };
    }
    const ask = (): void => {
      void book
        .ask(authors.split(',') as PubkeyHex[], getRelays())
        .then((known): void => {
          if (!cancelled) setStatuses(known);
        });
    };
    ask();
    // A screen left open outlives the book's belief in its answers, and a
    // status can run out on its own. Asking again on the book's own
    // schedule keeps both current; the book decides whether anyone is
    // actually asked, so a quiet screen costs nothing.
    const again = setInterval(ask, STATUS_ANSWER_TTL_SECONDS * 1000);
    return (): void => {
      cancelled = true;
      clearInterval(again);
    };
  }, [authors]);

  return statuses;
}

/** One person's status, for their profile. */
export function useUserStatus(pubkey: PubkeyHex): UserStatus | null {
  const one = useMemo((): { pubkey: PubkeyHex }[] => [{ pubkey }], [pubkey]);
  return useUserStatuses(one).get(pubkey) ?? null;
}
