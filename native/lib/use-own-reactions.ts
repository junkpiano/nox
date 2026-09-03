/**
 * Which of the posts on a screen you already liked or reposted.
 *
 * One book for the whole app, shared by every list and thread, so a post
 * seen on the home timeline is not asked about again on a profile. The
 * shared book decides who still needs asking; this ties it to a render,
 * and tells every screen when a like made on one of them lands.
 */

import { getPublicKey } from 'nostr-tools';
import { useEffect, useState } from 'react';
import {
  createReactionBook,
  type OwnReactions,
  type Reaction,
} from '../../src/common/own-reactions';
import { getSessionPrivateKey } from '../../src/common/session';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';
import { useSessionVersion } from './use-session-version';

const book = createReactionBook();
const listeners: Set<() => void> = new Set();

function announce(): void {
  for (const listener of Array.from(listeners)) listener();
}

const NOTHING: OwnReactions = { liked: new Set(), reposted: new Set() };

/** The key in this session, as a pubkey, or null when there is none. */
function viewer(): PubkeyHex | null {
  const key: Uint8Array | null = getSessionPrivateKey();
  return key ? (getPublicKey(key) as PubkeyHex) : null;
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
      if (!me) return;
      book.mark(me, id, reaction);
      announce();
    },
  };
}
