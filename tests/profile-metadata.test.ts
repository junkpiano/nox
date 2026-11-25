/**
 * Editing your own kind 0 without losing what you did not touch.
 *
 * A kind 0 replaces the whole profile on every relay that accepts it, so
 * whatever the editor leaves out is deleted for everyone. These tests pin
 * what must survive an edit. Spec: docs/features/edit-profile/spec.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import type { SubscriptionOpener } from '../src/common/relay-query.js';
import {
  applyProfileEdits,
  EDITABLE_PROFILE_FIELDS,
  NotEveryRelayAnsweredError,
  profileMetadataDraft,
  readOwnMetadata,
  UnreadableMetadataError,
} from '../src/features/profile/profile-metadata.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';
import { fakeRelay, memoryKv, signed } from './fake-relay.js';

memoryKv();

const me: Uint8Array = generateSecretKey();
const ME: PubkeyHex = getPublicKey(me) as PubkeyHex;

test('the editable fields are the web editor’s', () => {
  assert.deepEqual(
    [...EDITABLE_PROFILE_FIELDS],
    [
      'display_name',
      'name',
      'about',
      'picture',
      'banner',
      'website',
      'nip05',
      'lud16',
    ],
  );
});

test('PROFILE-EDIT-1: the newest kind 0 from every relay is the base', async () => {
  fakeRelay('wss://old.meta', {
    events: [
      signed(me, {
        kind: 0,
        content: '{"name":"old"}',
        tags: [['emoji', 'old', 'https://e.example/old.png']],
        created_at: 100,
      }),
    ],
  });
  fakeRelay('wss://new.meta', {
    events: [
      signed(me, {
        kind: 0,
        content: '{"name":"new","lud06":"lnurl1x"}',
        tags: [['i', 'github:me', 'proof']],
        created_at: 200,
      }),
    ],
  });

  const own = await readOwnMetadata(['wss://old.meta', 'wss://new.meta'], ME);
  assert.deepEqual(own.content, { name: 'new', lud06: 'lnurl1x' });
  assert.deepEqual(own.tags, [['i', 'github:me', 'proof']]);
  assert.equal(own.createdAt, 200);
});

test('PROFILE-EDIT-1: a slow relay holding the newest copy is waited for', async () => {
  const old: NostrEvent = signed(me, {
    kind: 0,
    content: '{"name":"old"}',
    created_at: 100,
  });
  const newer: NostrEvent = signed(me, {
    kind: 0,
    content: '{"name":"new"}',
    created_at: 200,
  });
  // Past the grace a first answer gets: a query that stopped there would
  // edit the old copy.
  const open: SubscriptionOpener = async (relayUrl, _filter, handlers) => {
    const slow: boolean = relayUrl === 'wss://slow.meta';
    setTimeout(
      (): void => {
        handlers.onEvent?.(slow ? newer : old);
        handlers.onEose?.();
      },
      slow ? 1700 : 0,
    );
    return (): void => {};
  };
  const own = await readOwnMetadata(
    ['wss://fast.meta', 'wss://slow.meta'],
    ME,
    open,
  );
  assert.deepEqual(own.content, { name: 'new' });
});

test('PROFILE-EDIT-1: someone with no profile yet starts from nothing', async () => {
  fakeRelay('wss://empty.meta');
  const own = await readOwnMetadata(['wss://empty.meta'], ME);
  assert.deepEqual(own, { content: {}, tags: [], createdAt: null });
});

test('PROFILE-EDIT-5: no relay answering is refused, not an empty profile', async () => {
  fakeRelay('wss://gone-a.meta', { refuses: true });
  fakeRelay('wss://gone-b.meta', { refuses: true });
  await assert.rejects(
    readOwnMetadata(['wss://gone-a.meta', 'wss://gone-b.meta'], ME),
    NotEveryRelayAnsweredError,
  );
});

test('PROFILE-EDIT-5: one relay missing is refused, even when another answered', async () => {
  // The one that answered has nothing; the one that did not may hold the
  // whole profile, and an edit from "nothing" would replace it.
  fakeRelay('wss://pruned.meta');
  fakeRelay('wss://holder.meta', { refuses: true });
  await assert.rejects(
    readOwnMetadata(['wss://pruned.meta', 'wss://holder.meta'], ME),
    NotEveryRelayAnsweredError,
  );
});

test('PROFILE-EDIT-5: a kind 0 whose content is not a JSON object is refused', async () => {
  for (const [i, content] of [
    'not json',
    '[1,2]',
    '"text"',
    'null',
  ].entries()) {
    const url = `wss://bad-${i}.meta`;
    fakeRelay(url, { events: [signed(me, { kind: 0, content })] });
    await assert.rejects(
      readOwnMetadata([url], ME),
      UnreadableMetadataError,
      content,
    );
  }
});

test('PROFILE-EDIT-2: fields not edited are kept as they were', () => {
  const base = { name: 'me', lud06: 'lnurl1x', bot: false, custom: { a: 1 } };
  const next = applyProfileEdits(base, { name: 'me2' });
  assert.deepEqual(next, {
    name: 'me2',
    lud06: 'lnurl1x',
    bot: false,
    custom: { a: 1 },
  });
  // The base is not changed in place.
  assert.equal(base.name, 'me');
});

test('PROFILE-EDIT-3: edits are trimmed, and an emptied field is removed', () => {
  const next = applyProfileEdits(
    { name: 'me', about: 'hello', nip05: 'me@example.com' },
    { name: '  you  ', about: '   ', nip05: '' },
  );
  assert.deepEqual(next, { name: 'you' });
});

test('PROFILE-EDIT-3: only fields named in the edits are touched', () => {
  const next = applyProfileEdits(
    { name: 'me', picture: 'https://p.example/a.png' },
    { about: 'new about' },
  );
  assert.deepEqual(next, {
    name: 'me',
    picture: 'https://p.example/a.png',
    about: 'new about',
  });
});

test('PROFILE-EDIT-4: website writes url too, and emptying it removes both', () => {
  assert.deepEqual(applyProfileEdits({}, { website: ' https://me.example ' }), {
    website: 'https://me.example',
    url: 'https://me.example',
  });
  assert.deepEqual(
    applyProfileEdits(
      { website: 'https://me.example', url: 'https://me.example', name: 'me' },
      { website: '' },
    ),
    { name: 'me' },
  );
  // Not editing website leaves url alone.
  assert.deepEqual(applyProfileEdits({ url: 'https://u.example' }, {}), {
    url: 'https://u.example',
  });
});

test('PROFILE-EDIT-2: the draft keeps the tags and carries the content as JSON', () => {
  const tags = [
    ['emoji', 'wave', 'https://e.example/wave.png'],
    ['i', 'github:me', 'proof'],
  ];
  const draft = profileMetadataDraft(
    ME,
    { name: 'me', lud06: 'lnurl1x' },
    tags,
    null,
    1_800_000_000,
  );
  assert.equal(draft.kind, 0);
  assert.equal(draft.pubkey, ME);
  assert.deepEqual(draft.tags, tags);
  assert.notEqual(draft.tags, tags);
  assert.deepEqual(JSON.parse(draft.content), { name: 'me', lud06: 'lnurl1x' });
  assert.equal(draft.created_at, 1_800_000_000);
});

test('PROFILE-EDIT-6: the new kind 0 is always later than the one it replaces', () => {
  // This device's clock is behind the event being replaced.
  const behind = profileMetadataDraft(ME, {}, [], 1_900_000_000, 1_800_000_000);
  assert.equal(behind.created_at, 1_900_000_001);
  const ahead = profileMetadataDraft(ME, {}, [], 1_700_000_000, 1_800_000_000);
  assert.equal(ahead.created_at, 1_800_000_000);
});
