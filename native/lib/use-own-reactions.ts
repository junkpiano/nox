/**
 * Which of the posts on a screen you already liked or reposted.
 *
 * One book for the whole app, shared by every list and thread, so a post
 * seen on the home timeline is not asked about again on a profile. The
 * shared book decides who still needs asking; this ties it to a render,
 * and tells every screen when a like made on one of them lands.
 */

import { useEffect, useState } from 'react';
import {
  createReactionBook,
  type OwnReactions,
  type Reaction,
} from '../../src/common/own-reactions';
import { getSession } from '../../src/common/session';
import { canWrite } from '../../src/common/signer';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';
import { useSessionVersion } from './use-session-version';

const book = createReactionBook();
const listeners: Set<() => void> = new Set();

function announce(): void {
  for (const listener of Array.from(listeners)) listener();
}

const NOTHING: OwnReactions = { liked: new Set(), reposted: new Set() };

/**
 * Whose reactions to ask about: the session's pubkey, whichever kind of
 * session. Browsing as a key shows that key's likes filled in too - the
 * relays hold them, and reading them signs nothing. Only marking a new
 * one needs the key, and that path is behind `canWrite()`.
 */
function viewer(): PubkeyHex | null {
  return getSession().pubkey;
}

export interface OwnReactionState extends OwnReactions {
  /** Records a reaction the app just published, for every screen at once. */
  mark(id: string, reaction: Reaction): void;
}

export function useOwnReactions(ids: ReadonlyArray<string>): OwnReactionState {
  // A new key is a new viewer; the book starts over and so does this.
  const sessionVersion = useSessionVersion();
  const [state, setState] = useState<OwnReactions>(NOTHING);
  const wanted: string = Array.from(new Set(ids)).sort().join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: the ids and the session are the dependencies, not the array
  useEffect((): (() => void) => {
    let cancelled = false;
    const me: PubkeyHex | null = viewer();
    if (!me) {
      setState(NOTHING);
      return (): void => {
        cancelled = true;
      };
    }
    const refresh = (): void => {
      if (!cancelled) setState(book.known(me));
    };
    listeners.add(refresh);
    refresh();
    if (wanted) {
      void book.ask(me, wanted.split(','), getRelays()).then((known): void => {
        if (!cancelled) setState(known);
      });
    }
    return (): void => {
      cancelled = true;
      listeners.delete(refresh);
    };
  }, [wanted, sessionVersion]);

  return {
    liked: state.liked,
    reposted: state.reposted,
    mark: (id: string, reaction: Reaction): void => {
      const me: PubkeyHex | null = viewer();
      if (!me || !canWrite()) return;
      book.mark(me, id, reaction);
      announce();
    },
  };
}
