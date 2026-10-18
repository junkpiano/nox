/**
 * Disconnecting while the stored connection is still being read.
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

await setMetadata('nwc_connection_v1', {
  walletPubkey: 'a'.repeat(64),
  relay: 'wss://relay.example.com',
});
local.items.set(
  'nwc_secret',
  Buffer.from('b'.repeat(64), 'utf8').toString('hex'),
);

test.after((): void => {
  console.log = quietLog;
});

test('a load still in flight when the wallet is disconnected does not bring it back', async () => {
  const loading = wallet.loadWalletConnection();
  await wallet.clearWalletConnection();
  assert.equal(await loading, null);
  assert.equal(wallet.getWalletConnection(), null);
  assert.equal(local.items.has('nwc_secret'), false);
});
