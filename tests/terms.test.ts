/**
 * Whether the gate opens.
 *
 * This is the one check standing between a fresh install and an unfiltered
 * global timeline, and it fails in the quiet direction: a bug here does not
 * throw, it just lets somebody straight through. So the cases worth writing
 * down are the ones where "accepted" is nearly true.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { setKvStore } from '../src/common/kv.js';
import {
  acceptTerms,
  clearTermsAcceptance,
  hasAcceptedTerms,
  TERMS_SUMMARY,
  TERMS_VERSION,
} from '../src/common/terms.js';

/** A store standing in for localStorage or the phone's key-value table. */
function installMemoryStore(): Map<string, string> {
  const values: Map<string, string> = new Map();
  setKvStore({
    get: (key: string): string | null => values.get(key) ?? null,
    set: (key: string, value: string): void => {
      values.set(key, value);
    },
    remove: (key: string): void => {
      values.delete(key);
    },
  });
  return values;
}

test('terms: a fresh device has not agreed', () => {
  installMemoryStore();
  assert.equal(hasAcceptedTerms(), false);
});

test('terms: agreeing is remembered', () => {
  installMemoryStore();
  acceptTerms();
  assert.equal(hasAcceptedTerms(), true);
});

test('terms: agreeing to an older version does not count', () => {
  // The documents changed, so the agreement was to something else. Carrying it
  // forward is how a client ends up claiming consent it never got.
  const values = installMemoryStore();
  values.set('terms_accepted_version', '2020-01-01');
  assert.equal(hasAcceptedTerms(), false);
});

test('terms: a truthy value that is not the version does not count', () => {
  // An older build wrote `true` here. That is agreement to an unknown text.
  const values = installMemoryStore();
  values.set('terms_accepted_version', 'true');
  assert.equal(hasAcceptedTerms(), false);
});

test('terms: clearing revokes it', () => {
  installMemoryStore();
  acceptTerms();
  clearTermsAcceptance();
  assert.equal(hasAcceptedTerms(), false);
});

test('terms: a store that reads back nothing keeps the gate shut', () => {
  // Private browsing, a cleared profile, a storage layer that failed to
  // install. Failing open would show the timeline to somebody who was never
  // asked.
  setKvStore({
    get: (): string | null => null,
    set: (): void => {},
    remove: (): void => {},
  });
  acceptTerms();
  assert.equal(hasAcceptedTerms(), false);
});

test('terms: the summary says the four things', () => {
  // Not a wording test - a presence test. Each of these is something the app
  // cannot do for you and that is discovered too late if it is not said first.
  assert.equal(TERMS_SUMMARY.length, 4);
  const all: string = TERMS_SUMMARY.map(
    (point): string => `${point.heading} ${point.body}`,
  )
    .join(' ')
    .toLowerCase();

  assert.ok(all.includes('relays'), 'says what it talks to');
  assert.ok(all.includes('not liable'), 'disclaims liability');
  assert.ok(all.includes('cannot be recovered'), 'warns about the key');
  assert.ok(all.includes('report'), 'names the tools for bad content');
});

test('terms: the version looks like the date on the document', () => {
  // Bumping the documents without bumping this is the failure mode, and the
  // two are meant to be compared by eye.
  assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});
