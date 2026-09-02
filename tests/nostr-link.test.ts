import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nip19 } from 'nostr-tools';
import { resolveNostrLink } from '../src/common/nostr-link.js';

const PUBKEY: string = 'a'.repeat(64);
const EVENT_ID: string = 'b'.repeat(64);
const npub: string = nip19.npubEncode(PUBKEY);
const note: string = nip19.noteEncode(EVENT_ID);
const nevent: string = nip19.neventEncode({
  id: EVENT_ID,
  relays: ['wss://hinted.example', 'ftp://not-a-relay'],
});
const nprofile: string = nip19.nprofileEncode({ pubkey: PUBKEY });

// --- every wrapper, one answer -------------------------------------------------

test('link: a person, however wrapped', () => {
  for (const input of [
    npub,
    `nostr:${npub}`,
    `web+nostr:${npub}`,
    `nox://${npub}`,
    `nox:${npub}`,
    `https://nox.garden/${npub}`,
    `https://www.nox.garden/${npub}/`,
    `  ${npub.toUpperCase()}  `,
    nprofile,
    `nostr:${nprofile}`,
  ]) {
    assert.deepEqual(
      resolveNostrLink(input),
      { kind: 'profile', pubkey: PUBKEY },
      input,
    );
  }
});

test('link: a note, with the relay hints an nevent carries and only the real ones', () => {
  assert.deepEqual(resolveNostrLink(`nostr:${note}`), {
    kind: 'event',
    eventId: EVENT_ID,
    relays: [],
  });
  assert.deepEqual(resolveNostrLink(`https://nox.garden/${nevent}`), {
    kind: 'event',
    eventId: EVENT_ID,
    relays: ['wss://hinted.example'],
  });
});

test('link: a tag, from the site path or as typed', () => {
  assert.deepEqual(resolveNostrLink('https://nox.garden/t/Nostr'), {
    kind: 'hashtag',
    tag: 'nostr',
  });
  assert.deepEqual(resolveNostrLink('nox://t/%E3%81%AD%E3%81%93'), {
    kind: 'hashtag',
    tag: 'ねこ',
  });
  assert.deepEqual(resolveNostrLink('#bitcoin'), {
    kind: 'hashtag',
    tag: 'bitcoin',
  });
});

// --- what is not followed -----------------------------------------------------------

test("link: somebody else's site, an address, a relay, nonsense: null", () => {
  for (const input of [
    `https://example.com/${npub}`,
    'https://nox.garden/',
    'https://nox.garden/settings',
    'nostr:naddr1qqxnzd3cxqmrzv3exgmr2wfeqgsxu35yyt0mwjjh8pcz4zprhxegz69t4wr9t74vk6zne58wzh0waycrqsqqqa28pjfdhz',
    'nostr:nrelay1qq08wumn8ghj7mn0wd68yttjv4kxz7fwv3jhyettwfhhxarj9e3xzmnyv9ux2angqtn',
    'npub1notbech32',
    '',
    'nostr:',
  ]) {
    assert.equal(resolveNostrLink(input), null, input);
  }
});
