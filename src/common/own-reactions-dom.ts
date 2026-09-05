/**
 * The ♡ and ⇄ on a card, filled in from what you already did.
 *
 * Every card used to start empty, so a post liked yesterday offered to be
 * liked again. The shared reaction book (`own-reactions.ts`) knows which
 * posts the viewer reacted to; this is the web's way of tying it to the
 * cards on screen. The phone does the same through a hook.
 *
 * Cards arrive one at a time from a render loop, so asking per card would
 * be one subscription per post. Instead a render notes each card, and the
 * next tick asks about all of them at once, then paints the answer onto
 * whichever of those cards are still in the document. A like made from a
 * card is written into the book and painted at once, without asking.
 */

import type { PubkeyHex } from '../../types/nostr';
import { getRelays } from '../features/relays/relays.js';
import {
  createReactionBook,
  type OwnReactions,
  type Reaction,
} from './own-reactions.js';
import { getSession } from './session.js';

const book = createReactionBook();

/** Cards rendered since the last ask, by event id. */
let noted: Map<string, Set<HTMLElement>> = new Map();
let scheduled: boolean = false;

/**
 * Whose reactions to ask about: the session's pubkey, whichever kind of
 * session. Browsing as a key shows that key's likes too - the relays hold
 * them, and reading them signs nothing.
 */
function viewer(): PubkeyHex | null {
  return getSession().pubkey;
}

const BUTTONS: Record<Reaction, string> = {
  like: '.react-event-btn',
  repost: '.repost-event-btn',
};

function paint(card: HTMLElement, reaction: Reaction, on: boolean): void {
  const button: HTMLElement | null = card.querySelector(BUTTONS[reaction]);
  if (!button) return;
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  // The idle title is whatever the card gave the button - it differs for
  // someone who cannot sign - and comes back when the reaction is gone.
  if (on) {
    if (button.dataset.idleTitle === undefined) {
      button.dataset.idleTitle = button.title;
    }
    button.title = reaction === 'like' ? 'Liked' : 'Reposted';
  } else if (button.dataset.idleTitle !== undefined) {
    button.title = button.dataset.idleTitle;
  }
}

function paintAll(
  cards: Iterable<HTMLElement>,
  id: string,
  known: OwnReactions,
): void {
  for (const card of cards) {
    if (!card.isConnected) continue;
    paint(card, 'like', known.liked.has(id));
    paint(card, 'repost', known.reposted.has(id));
  }
}

async function askAboutNoted(): Promise<void> {
  scheduled = false;
  const batch: Map<string, Set<HTMLElement>> = noted;
  noted = new Map();
  const me: PubkeyHex | null = viewer();
  if (!me || batch.size === 0) return;
  // What is already known is painted before the relays are asked, so a
  // card for a post seen on another page does not flicker empty first.
  const knownNow: OwnReactions = book.known(me);
  for (const [id, cards] of batch) paintAll(cards, id, knownNow);
  const known: OwnReactions = await book.ask(
    me,
    Array.from(batch.keys()),
    getRelays(),
  );
  if (viewer() !== me) return;
  for (const [id, cards] of batch) paintAll(cards, id, known);
}

/**
 * Notes a freshly rendered card. The ask happens on the next tick, once
 * for every card noted in the meantime.
 */
export function noteRenderedCard(card: HTMLElement, eventId: string): void {
  if (!viewer()) return;
  let cards: Set<HTMLElement> | undefined = noted.get(eventId);
  if (!cards) {
    cards = new Set();
    noted.set(eventId, cards);
  }
  cards.add(card);
  if (!scheduled) {
    scheduled = true;
    setTimeout((): void => void askAboutNoted(), 0);
  }
}

/**
 * Records a reaction the app just made, or took back, and paints every
 * card for that post that is on screen.
 *
 * `by` is whoever made it, taken when the action began: a publish waits
 * on the relays, and if the session changed meanwhile the result belongs
 * to a key no longer on screen and is dropped rather than written into
 * the wrong book.
 */
export function recordOwnReaction(
  by: PubkeyHex,
  eventId: string,
  reaction: Reaction,
  on: boolean,
): void {
  const me: PubkeyHex | null = viewer();
  if (!me || me !== by) return;
  if (on) book.mark(me, eventId, reaction);
  else book.unmark(me, eventId, reaction);
  const cards: NodeListOf<HTMLElement> = document.querySelectorAll(
    `.event-container[data-event-id="${CSS.escape(eventId)}"]`,
  );
  for (const card of cards) paint(card, reaction, on);
}
