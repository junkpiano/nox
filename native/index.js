/**
 * `react-native-get-random-values` is imported first, before anything can
 * reach for randomness. nostr-tools generates keys and NIP-44 nonces through
 * `crypto.getRandomValues`, which Hermes does not provide on its own, and a
 * later import would be exactly that - later than the module needing it.
 */
import 'react-native-get-random-values';

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
