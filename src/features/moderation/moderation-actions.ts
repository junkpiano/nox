import { isReadOnlySession } from '../../common/session.js';
/**
 * User-facing mute and report actions.
 *
 * Mutes are applied to the in-memory set first so the UI reacts immediately,
 * then published. A relay that rejects the write leaves the local state in
 * place: the user asked not to see this author, and showing them again because
 * a relay was unreachable is the worse failure.
 */

import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { kvGet } from '../../common/kv.js';
import {
  addMutedLocally,
  getMuteListCreatedAt,
  removeMutedLocally,
  setMutedWordsLocally,
  setMuteList,
} from '../../common/mute-state.js';
import { publishEventToRelays } from '../../common/publish-event.js';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import { recordRelayFailure } from '../relays/relays.js';
import type { MuteEntries } from './mute-entries.js';
import {
  MUTE_LIST_KIND,
  parseMuteListEvent,
  signMuteListEvent,
} from './mute-list.js';
import type { ReportType } from './report.js';
import { signReportEvent } from './report.js';

function getViewerPubkey(): PubkeyHex | null {
  // Browsing as a key: there is a pubkey, but nothing here can be decrypted
  // or signed for it, so for this feature there is nobody.
  if (isReadOnlySession()) {
    return null;
  }
  // Through the kv seam: on the web this is still localStorage, and on the
  // phone it is the same key in SQLite. Reading the global directly here was
  // the last thing keeping the mute list from working natively.
  const stored: string | null = kvGet('nostr_pubkey');
  return stored ? (stored as PubkeyHex) : null;
}

/**
 * Fetches the newest kind:10000 across relays and installs it.
 *
 * Runs in the background at startup; the cached list covers the interim.
 */
export async function refreshMuteListFromRelays(
  relays: string[],
): Promise<void> {
  const viewerPubkey: PubkeyHex | null = getViewerPubkey();
  if (!viewerPubkey || relays.length === 0) {
    return;
  }

  // Held in an object so TypeScript keeps the type across the socket
  // callbacks; a plain `let` narrows to null and loses it after the await.
  const newest: { event: NostrEvent | null } = { event: null };

  const promises: Promise<void>[] = relays.map(
    async (relayUrl: string): Promise<void> => {
      try {
        const socket: WebSocket = createRelayWebSocket(relayUrl);
        await new Promise<void>((resolve) => {
          let settled: boolean = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.close();
            resolve();
          };

          const timeout = setTimeout((): void => {
            recordRelayFailure(relayUrl);
            finish();
          }, 5000);

          socket.onopen = (): void => {
            const subId: string = `mute-${Math.random().toString(36).slice(2)}`;
            socket.send(
              JSON.stringify([
                'REQ',
                subId,
                {
                  kinds: [MUTE_LIST_KIND],
                  authors: [viewerPubkey],
                  limit: 1,
                },
              ]),
            );
          };

          socket.onmessage = (msg: MessageEvent): void => {
            try {
              const arr: unknown[] = JSON.parse(msg.data);
              if (arr[0] === 'EVENT') {
                const event = arr[2] as NostrEvent;
                if (
                  event?.kind === MUTE_LIST_KIND &&
                  (!newest.event || event.created_at >= newest.event.created_at)
                ) {
                  newest.event = event;
                }
                return;
              }
              if (arr[0] === 'EOSE') {
                finish();
              }
            } catch {
              finish();
            }
          };

          socket.onerror = (): void => {
            finish();
          };
        });
      } catch (error: unknown) {
        console.warn(
          `[mute] Failed to fetch mute list from ${relayUrl}:`,
          error,
        );
      }
    },
  );

  await Promise.allSettled(promises);

  const resolved: NostrEvent | null = newest.event;
  if (!resolved || resolved.created_at <= getMuteListCreatedAt()) {
    return;
  }

  try {
    const entries: MuteEntries = await parseMuteListEvent(
      resolved,
      viewerPubkey,
    );
    setMuteList(entries, resolved.created_at);
  } catch (error: unknown) {
    console.warn('[mute] Failed to apply fetched mute list:', error);
  }
}

/**
 * Publishes the whole list.
 *
 * It takes `MuteEntries` rather than a list of people on purpose: kind:10000
 * is replaceable, so a call that carried only the pubkeys would delete every
 * muted word - and every hashtag mute set in another client - the moment
 * somebody muted one more person.
 */
async function publishMuteList(
  entries: MuteEntries,
  relays: string[],
): Promise<void> {
  const viewerPubkey: PubkeyHex | null = getViewerPubkey();
  if (!viewerPubkey) {
    throw new Error('Sign in to change your mute list.');
  }

  const event: NostrEvent = await signMuteListEvent({
    pubkeyHex: viewerPubkey,
    entries,
  });

  setMuteList(entries, event.created_at);
  await publishEventToRelays(event, relays);
}

/** Mutes an author. Returns false when they were already muted. */
export async function muteUser(
  pubkey: PubkeyHex,
  relays: string[],
): Promise<boolean> {
  const updated: MuteEntries | null = addMutedLocally(pubkey);
  if (updated === null) {
    return false;
  }

  try {
    await publishMuteList(updated, relays);
  } catch (error: unknown) {
    // Keep the local mute: the user's intent outlives a failed publish.
    console.warn('[mute] Failed to publish mute list:', error);
    throw error;
  }
  return true;
}

export async function unmuteUser(
  pubkey: PubkeyHex,
  relays: string[],
): Promise<boolean> {
  const updated: MuteEntries | null = removeMutedLocally(pubkey);
  if (updated === null) {
    return false;
  }

  try {
    await publishMuteList(updated, relays);
  } catch (error: unknown) {
    console.warn('[mute] Failed to publish mute list:', error);
    throw error;
  }
  return true;
}

/**
 * Replaces the muted words. Returns false when the list is unchanged.
 *
 * The words are published in the encrypted half of the list, like the people:
 * what somebody would rather not read is nobody else's business.
 */
export async function setMutedWords(
  words: string[],
  relays: string[],
): Promise<boolean> {
  const updated: MuteEntries | null = setMutedWordsLocally(words);
  if (updated === null) {
    return false;
  }

  try {
    await publishMuteList(updated, relays);
  } catch (error: unknown) {
    console.warn('[mute] Failed to publish mute list:', error);
    throw error;
  }
  return true;
}

/**
 * Publishes a NIP-56 report.
 *
 * Reports are public by design: they are addressed to relay operators and
 * moderators, not to the viewer.
 */
export async function reportContent(params: {
  targetPubkey: PubkeyHex;
  eventId?: string;
  reportType: ReportType;
  comment?: string;
  relays: string[];
}): Promise<void> {
  const viewerPubkey: PubkeyHex | null = getViewerPubkey();
  if (!viewerPubkey) {
    throw new Error('Sign in to report content.');
  }

  const event: NostrEvent = await signReportEvent({
    pubkeyHex: viewerPubkey,
    targetPubkey: params.targetPubkey,
    ...(params.eventId ? { eventId: params.eventId } : {}),
    reportType: params.reportType,
    ...(params.comment ? { comment: params.comment } : {}),
  });

  await publishEventToRelays(event, params.relays);
}
