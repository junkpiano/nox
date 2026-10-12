/**
 * What the heart button sends: one tap, the person's own choice.
 *
 * Kept on the account, not the device, as NIP-78 app data (kind 30078,
 * `d` = `nox-reaction-emoji`): the reaction's content, and for a custom
 * emoji its `emoji` tag, exactly as a kind 7 would carry them. So the same
 * tap means the same thing on every device signed in.
 *
 * Read synchronously when a card is drawn, from a copy kept on the device;
 * the account's copy is fetched in the background and replaces it. Shared
 * with the phone: no DOM here.
 */

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { readEmojiTags } from './custom-emoji.js';
import { kvGet, kvSet } from './kv.js';
import { publishAndCount } from './publish-event.js';
import {
  getReactionAggregate,
  type ReactionAggregate,
} from './reaction-interactions.js';
import { newestOf, queryEveryRelay, supersedes } from './relay-query.js';
import { signWithSession } from './signer.js';

const APP_DATA_KIND: number = 30078;
const D_TAG: string = 'nox-reaction-emoji';

export const DEFAULT_QUICK_REACTION: ReactionAggregate = getReactionAggregate(
  '❤',
  [],
);

function localKey(viewer: PubkeyHex): string {
  return `nostr_quick_reaction:${viewer}`;
}

/** The reaction an event's content and tags name, if it is one nox sends. */
function reactionFrom(content: string, tags: string[][]): ReactionAggregate {
  const text: string = content.trim();
  if (!text) return DEFAULT_QUICK_REACTION;
  const reaction: ReactionAggregate = getReactionAggregate(text, tags);
  // A custom emoji is kept only as the NIP-30 reader would accept it.
  if (reaction.shortcode || /^:[^:\s]+:$/.test(text)) {
    const ok: boolean =
      Boolean(reaction.shortcode && reaction.imageUrl) &&
      readEmojiTags([
        ['emoji', reaction.shortcode ?? '', reaction.imageUrl ?? ''],
      ]).size > 0;
    return ok ? reaction : DEFAULT_QUICK_REACTION;
  }
  // Anything else is one emoji, not a sentence.
  return [...text].length <= 8 ? reaction : DEFAULT_QUICK_REACTION;
}

function tagsOf(reaction: ReactionAggregate): string[][] {
  return reaction.shortcode && reaction.imageUrl
    ? [['emoji', reaction.shortcode, reaction.imageUrl]]
    : [];
}

/** This device's copy, with the event it came from, for ordering. */
interface Saved {
  content: string;
  tags: string[][];
  created_at: number;
  id: string;
}

function readSaved(viewer: PubkeyHex): Saved | null {
  try {
    const raw: string | null = kvGet(localKey(viewer));
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Saved>;
    if (typeof saved.content !== 'string' || !Array.isArray(saved.tags)) {
      return null;
    }
    return {
      content: saved.content,
      tags: saved.tags,
      created_at: typeof saved.created_at === 'number' ? saved.created_at : 0,
      id: typeof saved.id === 'string' ? saved.id : '',
    };
  } catch {
    return null;
  }
}

/** The choice as last seen on this device; ❤ until one has been made. */
export function getQuickReaction(viewer: PubkeyHex | null): ReactionAggregate {
  const saved: Saved | null = viewer ? readSaved(viewer) : null;
  return saved
    ? reactionFrom(saved.content, saved.tags)
    : DEFAULT_QUICK_REACTION;
}

function remember(viewer: PubkeyHex, event: NostrEvent): void {
  const saved: Saved = {
    content: event.content,
    tags: event.tags.filter((tag: string[]): boolean => tag[0] === 'emoji'),
    created_at: event.created_at,
    id: event.id,
  };
  kvSet(localKey(viewer), JSON.stringify(saved));
}

/**
 * Brings the device's copy up to the account's. Resolves with the choice,
 * which is what the device already had when no relay holds one.
 */
export async function refreshQuickReaction(
  viewer: PubkeyHex,
  relays: string[],
): Promise<ReactionAggregate> {
  const event: NostrEvent | null = newestOf(
    await queryEveryRelay(relays, {
      kinds: [APP_DATA_KIND],
      authors: [viewer],
      '#d': [D_TAG],
      limit: 1,
    }),
  );
  // Only a copy newer than this device's replaces it: a slow answer must not
  // undo a choice saved here while it was on its way.
  const saved: Saved | null = readSaved(viewer);
  if (event && (!saved || supersedes(event, saved))) remember(viewer, event);
  return getQuickReaction(viewer);
}

/**
 * Makes `reaction` the one the heart button sends, on every device.
 * Counts as saved only once a relay has accepted it.
 */
export async function setQuickReaction(
  viewer: PubkeyHex,
  relays: string[],
  reaction: ReactionAggregate,
): Promise<void> {
  const signed: NostrEvent = await signWithSession({
    kind: APP_DATA_KIND,
    // After the last choice this device knows of, even within one second or
    // on a clock that runs behind another device's.
    created_at: Math.max(
      Math.floor(Date.now() / 1000),
      (readSaved(viewer)?.created_at ?? 0) + 1,
    ),
    tags: [['d', D_TAG], ...tagsOf(reaction)],
    content: reaction.content,
  });
  if ((await publishAndCount(signed, relays)) === 0) {
    throw new Error('No relay accepted the setting.');
  }
  // A refresh may have brought a newer choice in while this was sent.
  const saved: Saved | null = readSaved(viewer);
  if (!saved || supersedes(signed, saved)) remember(viewer, signed);
}
