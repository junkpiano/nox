/**
 * NIP-38 statuses for a screen, each person asked about once in a while.
 *
 * A status is decoration: worth one lookup for everyone on screen, not one
 * per card and not again on every scroll. The book remembers who has been
 * asked about - including those who turned out to have no status, which is
 * most people - so a list that grows only ever asks about the newcomers.
 *
 * Remembered, not forever. A status is a sentence about right now, and its
 * author may change it, clear it, or have set it to expire. So an answer is
 * believed for a few minutes and then asked for again, and a status is
 * dropped the moment the author's own `until` passes, whether or not
 * anybody has asked since.
 *
 * Asked is marked before the relays answer, so two screens asking at once
 * do not both ask - the second waits for the first's answer instead. A
 * lookup that fails outright (no relay answered) is forgotten at once, so
 * the next screen may try again; a relay that answered with nothing has
 * answered, and that is remembered like any other answer.
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

/**
 * How long an answer is believed before the person is asked about again.
 *
 * A status changes on the scale of a day, not a minute, and every ask is a
 * subscription across every relay. Five minutes catches a change while a
 * screen is still open without asking on every scroll.
 */
export const STATUS_ANSWER_TTL_SECONDS: number = 5 * 60;

export interface StatusBook {
  /**
   * Asks about the people not yet asked about, or asked about long enough
   * ago, and resolves with every status the book knows - not only the new
   * ones - so a caller can draw the whole screen from the answer.
   */
  ask(
    pubkeys: PubkeyHex[],
    relays: string[],
  ): Promise<Map<PubkeyHex, UserStatus>>;
  /** What the book knows now, without asking anyone. Expired ones are gone. */
  known(): Map<PubkeyHex, UserStatus>;
}

/** A unix time in seconds, injectable so the clock can be moved in a test. */
export type Clock = () => number;

const wallClock: Clock = (): number => Math.floor(Date.now() / 1000);

export function createStatusBook(
  lookup: StatusLookup = fetchUserStatuses,
  clock: Clock = wallClock,
): StatusBook {
  /** When each person was last asked about, whatever the answer. */
  const askedAt: Map<PubkeyHex, number> = new Map();
  const statuses: Map<PubkeyHex, UserStatus> = new Map();
  /**
   * The lookups still out, by person. A screen that asks about someone a
   * previous screen is already asking about does not ask again - but it
   * does wait for that answer, or it would draw itself from nothing and
   * never hear.
   */
  const pending: Map<PubkeyHex, Promise<void>> = new Map();

  /** Whether the person should be asked about now. */
  const due = (pubkey: PubkeyHex, now: number): boolean => {
    if (pending.has(pubkey)) return false;
    const at: number | undefined = askedAt.get(pubkey);
    return at === undefined || now - at >= STATUS_ANSWER_TTL_SECONDS;
  };

  /**
   * Drops what the authors themselves said to stop believing - and forgets
   * having asked them, so the next ask asks again even inside the TTL:
   * what was held has run out on its own, and there may be a newer one.
   */
  const forgetExpired = (now: number): void => {
    for (const [pubkey, status] of statuses) {
      if (status.until <= now) {
        statuses.delete(pubkey);
        askedAt.delete(pubkey);
      }
    }
  };

  const lookUp = async (
    fresh: PubkeyHex[],
    relays: string[],
  ): Promise<void> => {
    try {
      const found: Map<PubkeyHex, UserStatus> = await lookup({
        pubkeys: fresh,
        relays,
      });
      // An answer replaces what was held, including with nothing: the
      // person who cleared their status has no status now.
      for (const pubkey of fresh) {
        const status: UserStatus | undefined = found.get(pubkey);
        if (status) statuses.set(pubkey, status);
        else statuses.delete(pubkey);
      }
    } catch {
      // Nobody answered at all. That is not knowledge about anyone.
      for (const pubkey of fresh) askedAt.delete(pubkey);
    } finally {
      for (const pubkey of fresh) pending.delete(pubkey);
    }
  };

  return {
    async ask(pubkeys, relays) {
      const now: number = clock();
      forgetExpired(now);
      const wanted: PubkeyHex[] = Array.from(new Set(pubkeys));
      const fresh: PubkeyHex[] = wanted.filter((pubkey: PubkeyHex): boolean =>
        due(pubkey, now),
      );
      if (fresh.length > 0) {
        for (const pubkey of fresh) askedAt.set(pubkey, now);
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
      forgetExpired(clock());
      return new Map(statuses);
    },
    known() {
      forgetExpired(clock());
      return new Map(statuses);
    },
  };
}
