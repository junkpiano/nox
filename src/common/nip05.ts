import { nip05 } from 'nostr-tools';
import type { PubkeyHex } from '../../types/nostr';

export function isNip05Identifier(str: string): boolean {
  return str.includes('@');
}

/**
 * The address on a card, only once it is known to be this person's.
 *
 * A kind 0 can claim any address - "jack@cash.app" is a string anyone can
 * write - and the address is exactly the thing people trust on sight. So a
 * card shows it only after the domain has said this pubkey owns it. The
 * answer is remembered per address and pubkey for the session, and one
 * lookup serves every card that asks while it is out.
 */
const verified: Map<string, Promise<string | null>> = new Map();

export function verifiedNip05(
  pubkey: PubkeyHex,
  address: string | null | undefined,
): Promise<string | null> {
  const candidate: string = (address ?? '').trim();
  if (!candidate || !isNip05Identifier(candidate)) {
    return Promise.resolve(null);
  }
  const key: string = `${pubkey}\u0000${candidate.toLowerCase()}`;
  let pending: Promise<string | null> | undefined = verified.get(key);
  if (!pending) {
    pending = resolveNip05(candidate).then(
      (owner: PubkeyHex | null): string | null =>
        owner === pubkey ? candidate : null,
    );
    verified.set(key, pending);
  }
  return pending;
}

export async function resolveNip05(
  identifier: string,
): Promise<PubkeyHex | null> {
  try {
    const profile = await nip05.queryProfile(identifier);
    if (profile?.pubkey) {
      return profile.pubkey as PubkeyHex;
    }
    return null;
  } catch (error) {
    console.error('[NIP-05] Failed to resolve identifier:', identifier, error);
    return null;
  }
}
