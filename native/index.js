/**
 * `react-native-get-random-values` is imported first, before anything can
 * reach for randomness. nostr-tools generates keys and NIP-44 nonces through
 * `crypto.getRandomValues`, which Hermes does not provide on its own, and a
 * later import would be exactly that - later than the module needing it.
 */
import 'react-native-get-random-values';

import { registerRootComponent } from 'expo';

import App from './App';
import { installNativeStorage } from './platform/storage';

/**
 * Imports hoist, so this call runs *after* every module body above has already
 * been evaluated - it cannot be "first" no matter where the line is written.
 * That is fine, and deliberately survivable: the shared `kv` module starts on
 * an in-memory store and replays anything written into it when the real store
 * arrives. Nothing here reads a setting at import time, and if something ever
 * does, it gets the value rather than a crash.
 */
installNativeStorage();

registerRootComponent(App);
