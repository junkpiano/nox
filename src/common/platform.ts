/**
 * Which runtime this is, for the one question that needs to know.
 *
 * Layout does not: it branches on viewport width, so a phone browser gets the
 * phone treatment without anyone asking what it is running on, and there is
 * one layout to maintain rather than three. This file was deliberately not
 * written while adding iOS support, because nothing needed it yet.
 *
 * What needed it: the App Store treats a connected Lightning wallet as a
 * wallet, and asks that wallets come from developers registered as
 * organisations. Android has no such rule - Google's policy exempts
 * non-custodial wallets - so the feature stays there. The distinction is about
 * the store rather than the device, which is why a browser is `web` even on an
 * iPhone: nobody using Safari went through App Review.
 */

import { isNativeRuntime } from './native-http.js';

export type Platform = 'ios' | 'android' | 'web' | 'other';

/**
 * `other` rather than a guess.
 *
 * Desktop builds run natively too. Calling one of them `android` because the
 * check fell through would hide a feature from someone for no reason.
 */
export function detectPlatform(userAgent: string, isNative: boolean): Platform {
  if (!isNative) {
    return 'web';
  }
  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    return 'ios';
  }
  if (/Android/i.test(userAgent)) {
    return 'android';
  }
  return 'other';
}

/**
 * Set by a runtime that knows the answer outright.
 *
 * React Native does. It has no user agent to sniff and is not Tauri, so the
 * detection below would call an iPhone `web` and offer the wallet on exactly
 * the platform whose store forbids it. A wrong answer here is not a cosmetic
 * bug, so the runtime states the fact rather than leaving it to be inferred.
 */
let declared: Platform | null = null;

export function setPlatform(platform: Platform): void {
  declared = platform;
}

/** The platform this document is running on. */
export function currentPlatform(): Platform {
  if (declared) {
    return declared;
  }
  // Optional, because a user agent is a browser thing and this file is not
  // only used in one.
  const userAgent: string =
    typeof navigator === 'undefined' ? '' : (navigator.userAgent ?? '');
  return detectPlatform(userAgent, isNativeRuntime());
}

/**
 * True where a connected Lightning wallet must not be offered.
 *
 * Zapping is unaffected: without a wallet the zap composer shows the invoice
 * as a QR code, which is a payment request rather than a wallet, and is how
 * zapping worked before wallet support existed.
 */
export function hidesWallet(): boolean {
  return currentPlatform() === 'ios';
}
