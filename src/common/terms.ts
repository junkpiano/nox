/**
 * The first-launch agreement.
 *
 * Nothing is shown until this is accepted - not the global timeline, not a
 * profile, not a single post. That is the point of it rather than an
 * incidental strictness: the global timeline is unfiltered by definition, and
 * somebody who has not yet been told what this app is should not have a
 * stranger's post put in front of them by an app they just opened.
 *
 * The canonical documents are `docs/terms-of-use.md` and
 * `docs/privacy-policy.md`, served at /terms and /privacy. What lives here is
 * a summary of the parts a person actually needs to have read before they
 * start, and the record of having agreed. The summary is deliberately not a
 * replacement: it names where the full text is, and both builds render the
 * same points from this one list so they cannot drift apart.
 *
 * Acceptance is recorded per device, not per account, because there is no
 * account - the terms are about using the app, and the app is what is
 * installed here.
 */

import { kvGet, kvSet } from './kv.js';

/**
 * The date at the top of `docs/terms-of-use.md`.
 *
 * Kept as the version so a material change to the documents re-asks rather
 * than quietly relying on an agreement to something else. Bump this when that
 * date changes; leaving it behind is the failure mode, so the two are written
 * to be compared by eye.
 */
export const TERMS_VERSION: string = '2026-08-25';

const ACCEPTED_KEY: string = 'terms_accepted_version';

export const TERMS_URL: string = 'https://nox.garden/terms';
export const PRIVACY_URL: string = 'https://nox.garden/privacy';

export interface TermsPoint {
  heading: string;
  body: string;
}

/**
 * What somebody has to know before the first post appears.
 *
 * Four points, chosen because each one is a thing this app cannot do for you
 * and would otherwise be discovered too late: the content is not moderated,
 * the key is not recoverable, what you publish is not retractable, and there
 * is nobody to sue.
 */
export const TERMS_SUMMARY: ReadonlyArray<TermsPoint> = [
  {
    heading: 'This is a client, not a service',
    body:
      'nox reads from and writes to relays that you choose. There is no ' +
      'account and no server here: the developer stores none of your data ' +
      'and cannot see, moderate or remove anything anyone publishes.',
  },
  {
    heading: 'The content comes from strangers',
    body:
      'Posts are published by other people and are not reviewed by anyone ' +
      'before you see them. Some of it will be inaccurate, and some of it ' +
      'will be offensive. You can mute and report from any post or profile.',
  },
  {
    heading: 'Your key cannot be recovered',
    body:
      'Your private key lives on this device and nowhere else. If you lose ' +
      'it, nobody can restore it. Anyone who obtains it controls your ' +
      'account permanently. What you publish is public and cannot reliably ' +
      'be unpublished.',
  },
  {
    heading: 'No warranty, and no liability',
    body:
      'nox is free and provided as is. The developer is not liable for any ' +
      'loss arising from its use, including funds sent over Lightning, ' +
      'which cannot be reversed.',
  },
];

/**
 * True when this device has agreed to the current version.
 *
 * Synchronous on purpose: it is read before the first frame, and an
 * asynchronous answer means either a flash of the app behind the gate or a
 * blank screen while it resolves.
 */
export function hasAcceptedTerms(): boolean {
  return kvGet(ACCEPTED_KEY) === TERMS_VERSION;
}

export function acceptTerms(): void {
  kvSet(ACCEPTED_KEY, TERMS_VERSION);
}

/**
 * Forgets the agreement. Used by tests, and by nothing else - signing out is
 * about the key, and does not undo having read this.
 */
export function clearTermsAcceptance(): void {
  kvSet(ACCEPTED_KEY, '');
}
