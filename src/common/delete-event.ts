import { signWithSession } from './signer.js';
/**
 * NIP-09: asking the relays to forget a post.
 *
 * A request, not an erasure. Relays are free to keep it and some do, copies
 * other people already hold are theirs, and a client that ignores kind 5 will
 * go on showing it. Anywhere this is offered should say "ask" rather than
 * "delete", and the local copy is dropped whatever the relays decide.
 *
 * The signing lives here rather than in the web card renderer, where it was,
 * because the phone needs the same thing and the alternative was a second
 * implementation of a destructive operation. Publishing goes through the
 * shared publisher, so a relay that rejects it is reported the same way as
 * anywhere else.
 */

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { withClientTag } from './client-tag.js';
import { kvGet } from './kv.js';
import { publishAndCount, publishEventToRelays } from './publish-event.js';
import { NoRelayAnsweredError, queryRelaysDetailed } from './relay-query.js';

interface Nip07 {
  signEvent?: (event: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
}

function extension(): Nip07 | null {
  return (window as unknown as { nostr?: Nip07 }).nostr ?? null;
}

/**
 * Signs a kind:5 naming `target` and publishes it.
 *
 * Refuses to sign for anybody else's post. A deletion is only honoured from
 * the author, so signing one would produce an event every relay drops -
 * failing loudly beats publishing nothing and reporting success.
 */
export async function requestDeletion(
  target: NostrEvent,
  relays: string[],
): Promise<void> {
  const viewer: string | null = kvGet('nostr_pubkey');
  if (!viewer || viewer.toLowerCase() !== target.pubkey.toLowerCase()) {
    throw new Error('You can only delete your own posts.');
  }

  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = withClientTag({
    kind: 5,
    pubkey: viewer as PubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['e', target.id]],
    content: '',
  });

  const _nip07: Nip07 | null = extension();
  // Through the one signer, which refuses a read-only session first.
  const signedEvent: NostrEvent = await signWithSession(unsignedEvent);

  await publishEventToRelays(signedEvent, relays);
}

export interface RepostWithdrawal {
  /** How many of your reposts of the post the relays had. */
  found: number;
  /** How many relays accepted the request; 0 when there was nothing to ask. */
  accepted: number;
}

/**
 * Takes back your reposts of a post: one kind 5 naming every kind 6 or 16
 * of yours that points at it. Throws `NoRelayAnsweredError` when no relay
 * could say whether there were any.
 */
export async function withdrawReposts(
  viewer: PubkeyHex,
  targetId: string,
  relays: string[],
): Promise<RepostWithdrawal> {
  // Every relay, not the first few: a repost left on a slow one would be
  // shown again the next time the relays are asked.
  const { events, answered } = await queryRelaysDetailed(
    relays,
    { kinds: [6, 16], authors: [viewer], '#e': [targetId] },
    undefined,
    { everyRelay: true },
  );
  if (answered === 0) throw new NoRelayAnsweredError(relays);
  const ids: string[] = Array.from(
    new Set(
      events
        .filter(
          (event: NostrEvent): boolean =>
            event.pubkey === viewer &&
            event.tags.some(
              (tag: string[]): boolean => tag[0] === 'e' && tag[1] === targetId,
            ),
        )
        .map((event: NostrEvent): string => event.id),
    ),
  );
  if (ids.length === 0) return { found: 0, accepted: 0 };
  const kinds: Set<number> = new Set(
    events
      .filter((event: NostrEvent): boolean => ids.includes(event.id))
      .map((event: NostrEvent): number => event.kind),
  );
  const signed: NostrEvent = await signWithSession(
    withClientTag({
      kind: 5,
      pubkey: viewer,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ...ids.map((id: string): string[] => ['e', id]),
        ...Array.from(kinds).map((kind: number): string[] => [
          'k',
          String(kind),
        ]),
      ],
      content: '',
    }),
  );
  // Only the author can withdraw a repost; signed by whoever took over the
  // session meanwhile, the request would name reposts that are not theirs.
  if (signed.pubkey !== viewer) {
    throw new Error('The session changed. Try again.');
  }
  return { found: ids.length, accepted: await publishAndCount(signed, relays) };
}
