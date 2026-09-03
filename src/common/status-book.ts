/**
 * NIP-38 statuses for a screen, each person asked about once.
 *
 * A status is decoration: worth one lookup for everyone on screen, not one
 * per card and not again on every scroll. The book remembers who has been
 * asked about - including those who turned out to have no status, which is
 * most people - so a list that grows only ever asks about the newcomers.
 *
 * Asked is marked before the relays answer, so two screens asking at once
 * do not both ask. A lookup that fails outright is forgotten, so the next
 * screen may try again; silence about a person is remembered, because a
 * relay that answered with nothing has answered.
 */

import type { PubkeyHex } from '../../types/nostr';
import {
  fetchUserStatuses,
  type UserStatus,
} from '../features/profile/user-status.js';

export type StatusLookup = (params: {
  pubkeys: PubkeyHex[];
  relays: string[];
}) => Promise<Map<PubkeyHex, UserStatus>>;

export interface StatusBook {
  /**
   * Asks about the people not yet asked about, and resolves with every
   * status the book knows - not only the new ones - so a caller can draw
   * the whole screen from the answer.
   */
  ask(
    pubkeys: PubkeyHex[],
    relays: string[],
  ): Promise<Map<PubkeyHex, UserStatus>>;
  /** What the book knows now, without asking anyone. */
  known(): Map<PubkeyHex, UserStatus>;
}

export function createStatusBook(
  lookup: StatusLookup = fetchUserStatuses,
): StatusBook {
  const asked: Set<PubkeyHex> = new Set();
  const statuses: Map<PubkeyHex, UserStatus> = new Map();
  /**
   * The lookups still out, by person. A screen that asks about someone a
   * previous screen is already asking about does not ask again - but it
   * does wait for that answer, or it would draw itself from nothing and
   * never hear.
   */
  const pending: Map<PubkeyHex, Promise<void>> = new Map();

  const lookUp = async (
    fresh: PubkeyHex[],
    relays: string[],
  ): Promise<void> => {
    try {
      const found: Map<PubkeyHex, UserStatus> = await lookup({
        pubkeys: fresh,
        relays,
      });
      for (const [pubkey, status] of found) statuses.set(pubkey, status);
    } catch {
      // Nobody answered at all. That is not knowledge about anyone.
      for (const pubkey of fresh) asked.delete(pubkey);
    } finally {
      for (const pubkey of fresh) pending.delete(pubkey);
    }
  };

  return {
    async ask(pubkeys, relays) {
      const wanted: PubkeyHex[] = Array.from(new Set(pubkeys));
      const fresh: PubkeyHex[] = wanted.filter(
        (pubkey: PubkeyHex): boolean => !asked.has(pubkey),
      );
      if (fresh.length > 0) {
        for (const pubkey of fresh) asked.add(pubkey);
        const flight: Promise<void> = lookUp(fresh, relays);
        for (const pubkey of fresh) pending.set(pubkey, flight);
      }
      await Promise.all(
        Array.from(
          new Set(
            wanted
              .map((pubkey: PubkeyHex) => pending.get(pubkey))
              .filter(
                (flight): flight is Promise<void> => flight !== undefined,
              ),
          ),
        ),
      );
      return new Map(statuses);
    },
    known() {
      return new Map(statuses);
    },
  };
}
