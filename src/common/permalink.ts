/**
 * A post's address, to copy and paste elsewhere.
 *
 * The ID is an `nevent`: the id with its author and kind, so a client that
 * does not have the post can still look for it by who wrote it. The link is
 * that ID on nox.garden, always - a preview's address or the desktop app's
 * own origin would not be permanent.
 *
 * Shared with the phone: no DOM here.
 */

import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr';

const SITE: string = 'https://nox.garden';

export function eventId(
  event: Pick<NostrEvent, 'id' | 'pubkey' | 'kind'>,
): string {
  return nip19.neventEncode({
    id: event.id,
    author: event.pubkey,
    kind: event.kind,
  });
}

export function eventLink(
  event: Pick<NostrEvent, 'id' | 'pubkey' | 'kind'>,
): string {
  return `${SITE}/${eventId(event)}`;
}
