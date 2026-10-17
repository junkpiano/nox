/**
 * A stored wallet connection is put back together from its two halves.
 *
 * Its own file because the wallet store loads once per process.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { installFakeIndexedDb } from './fakes/fake-indexeddb.js';
import { installFakeStorage } from './fakes/fake-storage.js';

installFakeIndexedDb();
const { local } = installFakeStorage();
const quietLog = console.log;
console.log = (): void => {};

const { setMetadata } = await import('../src/common/db/index.js');
const wallet = await import('../src/features/wallet/wallet-store.js');

const SECRET: string = 'b'.repeat(64);
await setMetadata('nwc_connection_v1', {
  walletPubkey: 'a'.repeat(64),
  relay: 'wss://relay.example.com',
  lud16: 'me@example.com',
});
local.items.set('nwc_secret', Buffer.from(SECRET, 'utf8').toString('hex'));

test.after((): void => {
  console.log = quietLog;
});

test('on start the connection is rebuilt from metadata and the stored secret', async () => {
  const expected = {
    walletPubkey: 'a'.repeat(64),
    relay: 'wss://relay.example.com',
    secret: SECRET,
    lud16: 'me@example.com',
  };
  assert.deepEqual(await wallet.loadWalletConnection(), expected);
  assert.deepEqual(wallet.getWalletConnection(), expected);
  // Cached: a second load does not read the stores again.
  local.items.clear();
  assert.deepEqual(await wallet.loadWalletConnection(), expected);
});
