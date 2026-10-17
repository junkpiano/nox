/**
 * The About page's list of NIPs, and the icon names shared by every front end.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ICONS } from '../src/common/icons.js';
import {
  nipLabel,
  nipUrl,
  SUPPORTED_NIPS,
  ZAP_ADDRESS,
} from '../src/common/supported-nips.js';

test('a NIP is labelled and linked with its number padded to two digits', () => {
  assert.equal(nipLabel(5), 'NIP-05');
  assert.equal(nipLabel(65), 'NIP-65');
  assert.equal(
    nipUrl(1),
    'https://github.com/nostr-protocol/nips/blob/master/01.md',
  );
});

test('the supported list is in ascending order with each NIP once', () => {
  const numbers: number[] = SUPPORTED_NIPS.map((entry) => entry.nip);
  assert.deepEqual(
    numbers,
    [...numbers].sort((a, b) => a - b),
  );
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(ZAP_ADDRESS.includes('@'));
});

test('every icon names both an SF Symbol and a Material Symbol', () => {
  for (const [name, icon] of Object.entries(ICONS)) {
    assert.ok(icon.sf.length > 0, `${name} has an SF Symbol`);
    assert.ok(icon.material.length > 0, `${name} has a Material Symbol`);
  }
});
