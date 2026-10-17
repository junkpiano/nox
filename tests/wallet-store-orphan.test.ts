/**
 * Wallet metadata whose secret has gone counts as no wallet.
 *
 * Its own file because the wallet store loads once per process.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { installFakeIndexedDb } from './fakes/fake-indexeddb.js';
import { installFakeStorage } from './fakes/fake-storage.js';

installFakeIndexedDb();
installFakeStorage();
const quietLog = console.log;
console.log = (): void => {};

const { setMetadata } = await import('../src/common/db/index.js');
const wallet = await import('../src/features/wallet/wallet-store.js');

// No secret alongside: the credential store was cleared behind the app's back.
await setMetadata('nwc_connection_v1', {
  walletPubkey: 'a'.repeat(64),
  relay: 'wss://relay.example.com',
});

test.after((): void => {
  console.log = quietLog;
});

test('metadata without its secret is treated as disconnected, not half-configured', async () => {
  assert.equal(await wallet.loadWalletConnection(), null);
  assert.equal(wallet.getWalletConnection(), null);
});
