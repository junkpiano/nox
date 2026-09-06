/**
 * Whether the phone signs NIP-42 challenges, decided in Settings.
 *
 * The shared socket asks the viewer, right then, whether to sign a relay's
 * challenge; on the web that is a blocking confirm. A phone has no blocking
 * prompt, so the answer here is a preference the person set beforehand,
 * and the "asker" the socket consults simply reads it. Changing the
 * preference also rewrites the per-relay permissions the socket keeps, so
 * a relay once denied is not denied forever.
 */

import { setAsker } from '../../src/common/ask';
import { kvGet, kvSet } from '../../src/common/kv';
import { setRelayAuthPermissionForRelays } from '../../src/common/relay-socket';
import { getRelays } from '../../src/features/relays/relays';

const PREFERENCE_KEY: string = 'nostr_relay_auth_preference';

export function relayAuthAllowed(): boolean {
  return kvGet(PREFERENCE_KEY) === 'allow';
}

export function setRelayAuthAllowed(allowed: boolean): void {
  kvSet(PREFERENCE_KEY, allowed ? 'allow' : 'deny');
  setRelayAuthPermissionForRelays(getRelays(), allowed ? 'allow' : 'deny');
}

/** Installs the asker: the socket's question is answered from the preference. */
export function installNativeRelayAuth(): void {
  setAsker((): boolean => relayAuthAllowed());
}
