/**
 * Where a private key, the DM cache key and the wallet secret are kept.
 *
 * On the web that is `localStorage`, hex-encoded. Inside Tauri it is the
 * platform credential store, with a copy left by an older build moved across
 * and `localStorage` kept only as the fallback when the keyring fails. An
 * installed backend (React Native) is used exclusively, with no fallback.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteSecret,
  readSecret,
  type SecretBackend,
  setSecretBackend,
  writeSecret,
} from '../src/common/secret-store.js';
import { installFakeStorage } from './fakes/fake-storage.js';

const KEY: string = 'test_secret';
const BYTES: Uint8Array = new Uint8Array([0, 1, 15, 16, 171, 255]);

type Invoke = (command: string, args: Record<string, unknown>) => unknown;

/** Pretends to be Tauri: the runtime flag plus the IPC entry point. */
function asTauri(invoke: Invoke | null): void {
  const scope = globalThis as { isTauri?: boolean; window?: unknown };
  scope.isTauri = invoke !== null;
  scope.window = invoke
    ? {
        __TAURI_INTERNALS__: {
          invoke: async (
            command: string,
            args: Record<string, unknown>,
          ): Promise<unknown> => invoke(command, args),
        },
      }
    : undefined;
}

/** A keyring holding plain arrays, as the Rust side hands them over. */
function keyring(): { held: Map<string, number[]>; invoke: Invoke } {
  const held: Map<string, number[]> = new Map();
  return {
    held,
    invoke: (command: string, args: Record<string, unknown>): unknown => {
      const key = args.key as string;
      if (command === 'secret_get') return held.get(key) ?? null;
      if (command === 'secret_set') {
        held.set(key, args.value as number[]);
        return null;
      }
      if (command === 'secret_delete') {
        held.delete(key);
        return null;
      }
      throw new Error(`unknown command ${command}`);
    },
  };
}

function brokenKeyring(): Invoke {
  return (): never => {
    throw new Error('keyring unavailable');
  };
}

test.beforeEach((): void => {
  setSecretBackend(null);
  asTauri(null);
});

test('on the web a secret round-trips through localStorage as hex', async () => {
  const { local } = installFakeStorage();
  await writeSecret(KEY, BYTES);
  assert.equal(local.items.get(KEY), '00010f10abff');
  assert.deepEqual(await readSecret(KEY), BYTES);
});

test('on the web a missing secret reads as null', async () => {
  installFakeStorage();
  assert.equal(await readSecret(KEY), null);
});

test('on the web a storage that throws reads as null and writes nothing', async () => {
  const { local } = installFakeStorage();
  local.failing = true;
  await writeSecret(KEY, BYTES);
  assert.equal(await readSecret(KEY), null);
  // Deleting must not throw either.
  await deleteSecret(KEY);
  local.failing = false;
  assert.equal(local.items.size, 0);
});

test('deleting on the web clears both localStorage and sessionStorage', async () => {
  const { local, session } = installFakeStorage();
  local.items.set(KEY, 'aa');
  session.items.set(KEY, 'bb');
  await deleteSecret(KEY);
  assert.equal(local.items.has(KEY), false);
  assert.equal(session.items.has(KEY), false);
});

test('an installed backend is used exclusively, without touching localStorage', async () => {
  const { local } = installFakeStorage();
  const held: Map<string, Uint8Array> = new Map();
  const backend: SecretBackend = {
    get: async (key: string): Promise<Uint8Array | null> =>
      held.get(key) ?? null,
    set: async (key: string, value: Uint8Array): Promise<void> => {
      held.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      held.delete(key);
    },
  };
  setSecretBackend(backend);
  local.items.set(KEY, 'ff');

  assert.equal(await readSecret(KEY), null);
  await writeSecret(KEY, BYTES);
  assert.deepEqual(await readSecret(KEY), BYTES);
  assert.equal(local.items.get(KEY), 'ff');
  await deleteSecret(KEY);
  assert.equal(held.has(KEY), false);
  // The backend's delete does not reach localStorage either.
  assert.equal(local.items.get(KEY), 'ff');
});

test('a failing backend fails loudly rather than falling back', async () => {
  installFakeStorage();
  setSecretBackend({
    get: async (): Promise<Uint8Array | null> => {
      throw new Error('locked');
    },
    set: async (): Promise<void> => {
      throw new Error('locked');
    },
    delete: async (): Promise<void> => {
      throw new Error('locked');
    },
  });
  await assert.rejects(readSecret(KEY), /locked/);
  await assert.rejects(writeSecret(KEY, BYTES), /locked/);
  await assert.rejects(deleteSecret(KEY), /locked/);
});

test('under Tauri a secret is written to the credential store and the plaintext copy dropped', async () => {
  const { local } = installFakeStorage();
  local.items.set(KEY, 'deadbeef');
  const ring = keyring();
  asTauri(ring.invoke);

  await writeSecret(KEY, BYTES);
  assert.deepEqual(ring.held.get(KEY), Array.from(BYTES));
  assert.equal(local.items.has(KEY), false);
  assert.deepEqual(await readSecret(KEY), BYTES);
});

test('under Tauri a copy left in localStorage by an older build is migrated once', async () => {
  const { local } = installFakeStorage();
  local.items.set(KEY, '0a0b');
  const ring = keyring();
  asTauri(ring.invoke);

  assert.deepEqual(await readSecret(KEY), new Uint8Array([10, 11]));
  assert.deepEqual(ring.held.get(KEY), [10, 11]);
  assert.equal(local.items.has(KEY), false);
});

test('under Tauri nothing anywhere reads as null', async () => {
  installFakeStorage();
  asTauri(keyring().invoke);
  assert.equal(await readSecret(KEY), null);
});

test('under Tauri a broken keyring falls back to localStorage for reads and writes', async () => {
  const { local } = installFakeStorage();
  asTauri(brokenKeyring());

  await writeSecret(KEY, BYTES);
  assert.equal(local.items.get(KEY), '00010f10abff');
  assert.deepEqual(await readSecret(KEY), BYTES);
});

test('under Tauri deleting clears localStorage and the keyring, and survives a broken keyring', async () => {
  const { local } = installFakeStorage();
  const ring = keyring();
  ring.held.set(KEY, [1]);
  local.items.set(KEY, '01');
  asTauri(ring.invoke);
  await deleteSecret(KEY);
  assert.equal(ring.held.has(KEY), false);
  assert.equal(local.items.has(KEY), false);

  local.items.set(KEY, '01');
  asTauri(brokenKeyring());
  await deleteSecret(KEY);
  assert.equal(local.items.has(KEY), false);
});
