/**
 * Turns whatever a user pastes into a pubkey.
 *
 * People copy identities from wherever they happen to be looking: a profile
 * URL, someone's bio, a QR scan. Accepting only one encoding would make
 * starting a conversation an exercise in format conversion.
 */

import { nip19 } from 'nostr-tools';
import type { PubkeyHex } from '../../../types/nostr';
import { isNip05Identifier, resolveNip05 } from '../../common/nip05.js';

export async function resolveRecipient(input: string): Promise<PubkeyHex> {
  const trimmed: string = input.trim().replace(/^nostr:/, '');
  if (!trimmed) {
    throw new Error('Enter an npub or a name like user@example.com.');
  }

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase() as PubkeyHex;
  }

  if (trimmed.startsWith('npub1') || trimmed.startsWith('nprofile1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'npub') {
        return decoded.data as PubkeyHex;
      }
      if (decoded.type === 'nprofile') {
        return (decoded.data as { pubkey: string }).pubkey as PubkeyHex;
      }
    } catch {
      throw new Error('That npub could not be decoded.');
    }
    throw new Error('That is not a profile identifier.');
  }

  if (isNip05Identifier(trimmed)) {
    const resolved: PubkeyHex | null = await resolveNip05(trimmed);
    if (!resolved) {
      throw new Error(`Could not find ${trimmed}.`);
    }
    return resolved;
  }

  throw new Error('Enter an npub or a name like user@example.com.');
}
