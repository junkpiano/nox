/**
 * Reading and publishing your own profile, for the Edit profile screen.
 *
 * The rules - start from the newest copy on every relay, keep what was not
 * edited - are the shared `profile-metadata.ts`; this signs with the session
 * key, sends to your relays and tells the profile screen.
 */

import { emitAppEvent } from '../../src/common/app-events';
import { cacheResolvedProfile } from '../../src/common/profile-fetch';
import {
  applyProfileEdits,
  type OwnMetadata,
  type ProfileEdits,
  profileMetadataDraft,
  readOwnMetadata,
} from '../../src/features/profile/profile-metadata';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';
import {
  type PublishResult,
  publishSigned,
  signEventWithSession,
} from './publish';

/** What `profile-updated` carries: the profile exactly as it was published. */
export interface ProfileUpdate {
  pubkey: PubkeyHex;
  content: Record<string, unknown>;
  tags: string[][];
}

/** Your newest kind 0 from every relay you use. Throws when it cannot be read. */
export function loadOwnMetadata(viewer: PubkeyHex): Promise<OwnMetadata> {
  return readOwnMetadata(getRelays(), viewer);
}

export class NotAcceptedError extends Error {
  constructor() {
    super('No relay accepted your profile.');
    this.name = 'NotAcceptedError';
  }
}

/**
 * Publishes `base` with `edits` applied, keeping every field and tag it did
 * not touch. Throws `NotAcceptedError` when no relay took it; then nothing is
 * cached, so the screen still shows what is really published.
 */
export async function saveOwnMetadata(
  viewer: PubkeyHex,
  base: OwnMetadata,
  edits: ProfileEdits,
): Promise<PublishResult> {
  const content: Record<string, unknown> = applyProfileEdits(
    base.content,
    edits,
  );
  const draft = profileMetadataDraft(
    viewer,
    content,
    base.tags,
    base.createdAt,
  );
  const event: NostrEvent = await signEventWithSession(draft);
  const result: PublishResult = await publishSigned(event);
  if (result.accepted.length === 0) throw new NotAcceptedError();

  // Cached with its emoji tags, or every card drawn afterwards would show
  // the shortcodes instead of the pictures.
  const profile: NostrProfile = {
    ...(content as NostrProfile),
    emojiTags: base.tags.filter((tag: string[]): boolean => tag[0] === 'emoji'),
  };
  await cacheResolvedProfile(viewer, profile).catch((): void => {});
  // Handed over as published rather than read back: a relay that refused
  // this one still holds the old copy and may answer first.
  const update: ProfileUpdate = { pubkey: viewer, content, tags: base.tags };
  emitAppEvent('profile-updated', update);
  return result;
}
