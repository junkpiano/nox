/**
 * The phone's side of `src/common/avatar.ts`.
 *
 * A picture URL from a kind 0 is whatever its owner wrote. The shared rule
 * decides whether this device could load it at all; here the policy is the
 * phone's: a release build blocks plain `http:` (Android cleartext, iOS
 * ATS), and neither has Tor for an `.onion` host. A picture that cannot
 * load is dropped before an <Image> is asked for it, so the row shows its
 * initial rather than a request that was always going to fail.
 */

import { type ImagePolicy, loadableImageUrl } from '../../src/common/avatar';

const PHONE: ImagePolicy = { secureOnly: true };

/** The picture URL if the phone could show it, else null. */
export function pictureUrl(raw: unknown): string | null {
  return typeof raw === 'string' ? loadableImageUrl(raw, PHONE) : null;
}
