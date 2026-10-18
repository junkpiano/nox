/**
 * Muting and reporting: the list is private to the viewer, travels whole,
 * and survives a relay that refuses it; a report is public and says what it
 * is about.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from 'nostr-tools';
import {
  clearMuteList,
  getMutedPubkeys,
  getMutedWords,
  getMuteListCreatedAt,
  isMuted,
} from '../src/common/mute-state.js';
import {
  endSession,
  setSessionPrivateKeyFromRaw,
  startReadOnlySession,
} from '../src/common/session.js';
import {
  muteUser,
  refreshMuteListFromRelays,
  reportContent,
  setMutedWords,
  unmuteUser,
} from '../src/features/moderation/moderation-actions.js';
import {
  MUTE_LIST_KIND,
  parseMuteListEvent,
  signMuteListEvent,
} from '../src/features/moderation/mute-list.js';
import {
  REPORT_KIND,
  REPORT_TYPE_LABELS,
  signReportEvent,
} from '../src/features/moderation/report.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';
import { fakeRelays, installFakeWebSocket, storeRelay } from './fake-relay-store.js';

installFakeWebSocket();

const key: Uint8Array = generateSecretKey();
const me: PubkeyHex = getPublicKey(key) as PubkeyHex;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const someone = (n: number): PubkeyHex =>
  n.toString(16).padStart(64, '0') as PubkeyHex;

function signIn(): void {
  setSessionPrivateKeyFromRaw(hex(key));
}

/** What the viewer would read back out of a published list. */
function decrypt(event: NostrEvent): string[][] {
  return JSON.parse(
    nip44.decrypt(event.content, nip44.getConversationKey(key, me)),
  ) as string[][];
}

const held: NostrEvent[] = [];
fakeRelays.set('wss://mod.example', storeRelay(held));
fakeRelays.set('wss://refuses.example', storeRelay([], false));
const RELAYS: string[] = ['wss://mod.example'];

const latest = (kind: number): NostrEvent | undefined =>
  held.filter((event: NostrEvent): boolean => event.kind === kind).pop();

test('a report on a note names the note with the type and the author plainly', async () => {
  signIn();
  const event: NostrEvent = await signReportEvent({
    pubkeyHex: me,
    targetPubkey: someone(1),
    eventId: 'e'.repeat(64),
    reportType: 'spam',
    comment: 'buy now',
  });
  assert.equal(event.kind, REPORT_KIND);
  assert.deepEqual(event.tags, [
    ['e', 'e'.repeat(64), 'spam'],
    ['p', someone(1)],
  ]);
  assert.equal(event.content, 'buy now');
});

test('a report on an account puts the type on the p tag and has empty content', async () => {
  signIn();
  const event: NostrEvent = await signReportEvent({
    pubkeyHex: me,
    targetPubkey: someone(1),
    reportType: 'impersonation',
  });
  assert.deepEqual(event.tags, [['p', someone(1), 'impersonation']]);
  assert.equal(event.content, '');
});

test('every report type has a label, each once', () => {
  const values = REPORT_TYPE_LABELS.map(({ value }): string => value);
  assert.equal(new Set(values).size, 7);
  assert.ok(values.includes('other'));
});

test('a signed mute list hides its entries and reads back whole', async () => {
  signIn();
  const event: NostrEvent = await signMuteListEvent({
    pubkeyHex: me,
    entries: {
      pubkeys: [someone(1)],
      words: ['spoiler'],
      otherTags: [['t', 'nsfw']],
    },
  });
  assert.equal(event.kind, MUTE_LIST_KIND);
  assert.deepEqual(event.tags, []);
  assert.ok(!event.content.includes(someone(1)));
  assert.deepEqual(await parseMuteListEvent(event, me), {
    pubkeys: [someone(1)],
    words: ['spoiler'],
    otherTags: [['t', 'nsfw']],
  });
});

test('public entries from another client are kept, even when the private half cannot be read', async () => {
  signIn();
  const event: NostrEvent = finalizeEvent(
    {
      kind: MUTE_LIST_KIND,
      created_at: 1_700_000_000,
      tags: [['p', someone(2)]],
      content: 'not something this key can decrypt',
    },
    key,
  ) as unknown as NostrEvent;
  const entries = await parseMuteListEvent(event, me);
  assert.deepEqual(entries.pubkeys, [someone(2)]);
});

test('the newest list on the relays is installed, and an older one is not', async () => {
  signIn();
  clearMuteList();
  const content: string = nip44.encrypt(
    JSON.stringify([
      ['p', someone(3)],
      ['word', 'Football'],
    ]),
    nip44.getConversationKey(key, me),
  );
  const remote: NostrEvent = finalizeEvent(
    { kind: MUTE_LIST_KIND, created_at: 1_700_000_000, tags: [], content },
    key,
  ) as unknown as NostrEvent;
  fakeRelays.set('wss://remote-list.example', storeRelay([remote]));
  await refreshMuteListFromRelays(['wss://remote-list.example']);
  assert.equal(getMuteListCreatedAt(), 1_700_000_000);
  assert.equal(isMuted(someone(3)), true);
  assert.deepEqual(getMutedWords(), ['football']);

  const stale: NostrEvent = finalizeEvent(
    { kind: MUTE_LIST_KIND, created_at: 1_600_000_000, tags: [], content: '' },
    key,
  ) as unknown as NostrEvent;
  fakeRelays.set('wss://stale-list.example', storeRelay([stale]));
  await refreshMuteListFromRelays(['wss://stale-list.example']);
  assert.equal(isMuted(someone(3)), true);
});

test('refreshing with nobody signed in, or no relays, does nothing', async () => {
  endSession();
  await refreshMuteListFromRelays(RELAYS);
  signIn();
  await refreshMuteListFromRelays([]);
  assert.equal(isMuted(someone(3)), true);
});

test('muting publishes the whole list, words included, and muting twice is a no-op', async () => {
  signIn();
  assert.equal(await muteUser(someone(4), RELAYS), true);
  assert.equal(await muteUser(someone(4), RELAYS), false);
  const published = latest(MUTE_LIST_KIND);
  assert.ok(published);
  assert.equal(published.pubkey, me);
  const tags = decrypt(published);
  assert.ok(tags.some((tag: string[]): boolean => tag[1] === someone(4)));
  assert.ok(tags.some((tag: string[]): boolean => tag[1] === someone(3)));
  assert.ok(
    tags.some(
      (tag: string[]): boolean => tag[0] === 'word' && tag[1] === 'football',
    ),
  );
});

test('unmuting publishes the list without them, and unmuting a stranger is a no-op', async () => {
  signIn();
  assert.equal(await unmuteUser(someone(4), RELAYS), true);
  assert.equal(await unmuteUser(someone(99), RELAYS), false);
  assert.equal(isMuted(someone(4)), false);
  const tags = decrypt(latest(MUTE_LIST_KIND) as NostrEvent);
  assert.ok(!tags.some((tag: string[]): boolean => tag[1] === someone(4)));
});

test('muted words are trimmed and lowercased, and the same words twice change nothing', async () => {
  signIn();
  assert.equal(
    await setMutedWords(['  Spoiler ', 'spoiler', ''], RELAYS),
    true,
  );
  assert.deepEqual(getMutedWords(), ['spoiler']);
  assert.equal(await setMutedWords(['spoiler'], RELAYS), false);
});

test('a relay refusing the list leaves the mute in place', async () => {
  signIn();
  assert.equal(await muteUser(someone(5), ['wss://refuses.example']), true);
  assert.ok(getMutedPubkeys().includes(someone(5)));
});

test('without a signed-in viewer, a mute stays local and the publish throws', async () => {
  startReadOnlySession(me);
  await assert.rejects(muteUser(someone(6), RELAYS), /Sign in to change/);
  // The mute was applied before the publish failed, as the module promises.
  assert.equal(isMuted(someone(6)), true);
  endSession();
  await assert.rejects(unmuteUser(someone(6), RELAYS), /Sign in/);
  await assert.rejects(setMutedWords(['new'], RELAYS), /Sign in/);
});

test('a report is signed by the viewer and sent to the relays', async () => {
  signIn();
  await reportContent({
    targetPubkey: someone(7),
    eventId: 'a'.repeat(64),
    reportType: 'malware',
    comment: 'drive-by download',
    relays: RELAYS,
  });
  const report = latest(REPORT_KIND);
  assert.equal(report?.pubkey, me);
  assert.equal(report?.content, 'drive-by download');
  endSession();
  await assert.rejects(
    reportContent({
      targetPubkey: someone(7),
      reportType: 'spam',
      relays: RELAYS,
    }),
    /Sign in to report/,
  );
});

test('without a key in the session, the extension encrypts and decrypts the list', async () => {
  endSession();
  const calls: string[] = [];
  (globalThis as unknown as { window: object }).window = {
    nostr: {
      nip44: {
        encrypt: async (pubkey: string, plaintext: string): Promise<string> => {
          calls.push(`encrypt:${pubkey}`);
          return `sealed:${plaintext}`;
        },
        decrypt: async (
          pubkey: string,
          ciphertext: string,
        ): Promise<string> => {
          calls.push(`decrypt:${pubkey}`);
          return ciphertext.replace(/^sealed:/, '');
        },
      },
      signEvent: async (event: object): Promise<NostrEvent> =>
        finalizeEvent(
          event as Parameters<typeof finalizeEvent>[0],
          key,
        ) as unknown as NostrEvent,
    },
  };
  try {
    const event: NostrEvent = await signMuteListEvent({
      pubkeyHex: me,
      entries: { pubkeys: [someone(8)], words: [], otherTags: [] },
    });
    assert.deepEqual((await parseMuteListEvent(event, me)).pubkeys, [
      someone(8),
    ]);
    assert.deepEqual(calls, [`encrypt:${me}`, `decrypt:${me}`]);

    (globalThis as unknown as { window: object }).window = {};
    await assert.rejects(
      signMuteListEvent({
        pubkeyHex: me,
        entries: { pubkeys: [], words: [], otherTags: [] },
      }),
      /No key available to encrypt/,
    );
  } finally {
    delete (globalThis as unknown as { window?: object }).window;
  }
});
