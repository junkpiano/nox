/**
 * Puts each author's status on their cards in a timeline.
 *
 * One lookup for the whole screen rather than one per card: a Nostr filter
 * takes a list of authors, so the cost of showing these is a single
 * subscription however many people are on screen. Doing it per card was the
 * reason not to show them here at all.
 *
 * Cards already on screen keep whatever they were given, so scrolling only
 * ever asks about authors that have appeared since.
 */

import type { PubkeyHex } from '../../types/nostr';
import {
  fetchUserStatuses,
  type UserStatus,
} from '../features/profile/user-status.js';

/** Marks a card as already asked about, whatever the answer was. */
const RESOLVED: string = 'statusResolved';

function pendingCards(output: HTMLElement): HTMLElement[] {
  return Array.from(
    output.querySelectorAll<HTMLElement>('.event-container'),
  ).filter(
    (card: HTMLElement): boolean =>
      card.dataset[RESOLVED] !== 'true' && Boolean(card.dataset.pubkey),
  );
}

/**
 * Fills in what is known, quietly.
 *
 * A status is decoration on a card. Not finding one, and failing to look, both
 * render as nothing - so there is no error path here worth telling anyone
 * about.
 */
export async function applyStatusesToTimeline(
  output: HTMLElement,
  relays: string[],
): Promise<void> {
  const cards: HTMLElement[] = pendingCards(output);
  if (cards.length === 0) {
    return;
  }

  const pubkeys: PubkeyHex[] = cards
    .map((card: HTMLElement): PubkeyHex => card.dataset.pubkey as PubkeyHex)
    .filter(Boolean);

  // Marked before the lookup, not after: a second call while this one is in
  // flight should not ask the same question again.
  for (const card of cards) {
    card.dataset[RESOLVED] = 'true';
  }

  let statuses: Map<PubkeyHex, UserStatus>;
  try {
    statuses = await fetchUserStatuses({ pubkeys, relays });
  } catch {
    return;
  }

  for (const card of cards) {
    const status: UserStatus | undefined = statuses.get(
      card.dataset.pubkey as PubkeyHex,
    );
    if (!status) {
      continue;
    }
    // Queried fresh rather than held from before the await: the card may have
    // been re-rendered while the lookup was out.
    const element: HTMLElement | null = card.querySelector('.event-status');
    if (!element) {
      continue;
    }
    element.textContent = status.text;
    element.classList.remove('hidden');
  }
}
