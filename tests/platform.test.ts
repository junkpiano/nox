/**
 * Telling the three runtimes apart.
 *
 * Layout does not need this - it branches on viewport width, so a phone
 * browser gets the phone treatment without anyone asking what it is running
 * on. This exists for one thing: the App Store treats a wallet as a wallet,
 * and the rule is about the store rather than the device. Someone using nox in
 * Safari on an iPhone is not going through App Review and keeps the feature.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPlatform } from '../src/common/platform.js';

const IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

test('the native iOS shell is the case this exists for', () => {
  assert.equal(detectPlatform(IOS, true), 'ios');
  assert.equal(detectPlatform(IPAD, true), 'ios');
});

test('the native Android shell is itself', () => {
  assert.equal(detectPlatform(ANDROID, true), 'android');
});

test('a browser is web, whatever it is running on', () => {
  // The rule being served here is the App Store's, not the device's. Safari on
  // an iPhone never goes through App Review, so it keeps everything.
  assert.equal(detectPlatform(IOS, false), 'web');
  assert.equal(detectPlatform(IPAD, false), 'web');
  assert.equal(detectPlatform(ANDROID, false), 'web');
  assert.equal(detectPlatform(MAC, false), 'web');
});

test('a native shell that is neither is not guessed at', () => {
  // Desktop builds run natively too. They are not iOS, and calling them
  // android because the check fell through would be worse than saying so.
  assert.equal(detectPlatform(MAC, true), 'other');
  assert.equal(detectPlatform('', true), 'other');
});
