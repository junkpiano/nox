/**
 * Keeping the wallet connection.
 *
 * The secret is a spending key and goes to the secret store; the rest is
 * ordinary metadata. Loading from what is already stored is in
 * wallet-store-restore.test.ts, since the store loads once per process.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { installFakeIndexedDb } from './fakes/fake-indexeddb.js';
import { installFakeStorage } from './fakes/fake-storage.js';

installFakeIndexedDb();
const { local } = installFakeStorage();
const quietLog = console.log;
console.log = (): void => {};

const { onAppEvent } = await import('../src/common/app-events.js');
const { getMetadata } = await import('../src/common/db/index.js');
const wallet = await import('../src/features/wallet/wallet-store.js');
type NwcConnection =
  import('../src/features/wallet/nwc-client.js').NwcConnection;

const CONNECTION: NwcConnection = {
  walletPubkey: 'a'.repeat(64),
  relay: 'wss://relay.example.com',
  secret: 'b'.repeat(64),
  lud16: 'me@example.com',
};

let changes: number = 0;
onAppEvent('wallet-connection-changed', (): void => {
  changes += 1;
});

test.after((): void => {
  console.log = quietLog;
});

test('with nothing saved there is no wallet', async () => {
  assert.equal(await wallet.loadWalletConnection(), null);
  assert.equal(wallet.getWalletConnection(), null);
  assert.equal(await wallet.getWalletAlias(), null);
});

test('saving keeps the secret in the secret store and only the rest in metadata', async () => {
  await wallet.saveWalletConnection(CONNECTION, 'My Wallet');

  assert.deepEqual(wallet.getWalletConnection(), CONNECTION);
  assert.equal(
    local.items.get('nwc_secret'),
    Buffer.from(CONNECTION.secret, 'utf8').toString('hex'),
  );
  const meta = await getMetadata<Record<string, unknown>>('nwc_connection_v1');
  assert.deepEqual(meta, {
    walletPubkey: CONNECTION.walletPubkey,
    relay: CONNECTION.relay,
    lud16: 'me@example.com',
    alias: 'My Wallet',
  });
  assert.equal(JSON.stringify(meta).includes(CONNECTION.secret), false);
  assert.equal(await wallet.getWalletAlias(), 'My Wallet');
  assert.equal(changes, 1);
});

test('a connection without a lightning address or alias stores neither', async () => {
  const { lud16: _unused, ...plain } = CONNECTION;
  await wallet.saveWalletConnection(plain);
  const meta = await getMetadata<Record<string, unknown>>('nwc_connection_v1');
  assert.deepEqual(Object.keys(meta ?? {}).sort(), ['relay', 'walletPubkey']);
  assert.deepEqual(wallet.getWalletConnection(), plain);
});

test('disconnecting removes both halves and says so', async () => {
  await wallet.saveWalletConnection(CONNECTION, 'My Wallet');
  const before: number = changes;
  await wallet.clearWalletConnection();

  assert.equal(wallet.getWalletConnection(), null);
  assert.equal(await wallet.loadWalletConnection(), null);
  assert.equal(local.items.has('nwc_secret'), false);
  assert.equal(await getMetadata('nwc_connection_v1'), null);
  assert.equal(await wallet.getWalletAlias(), null);
  assert.equal(changes, before + 1);
});
