/**
 * Which runtime this is, for the one question that needs to know.
 *
 * Layout does not: it branches on viewport width, so a phone browser gets the
 * phone treatment without anyone asking what it is running on, and there is
 * one layout to maintain rather than three. This file was deliberately not
 * written while adding iOS support, because nothing needed it yet.
 *
 * What needed it: a store may treat the connected Lightning wallet as a
 * wallet app, and ask for a status an individual developer cannot have (an
 * organisation account on the App Store, a financial licence on Google Play).
 * nox holds no funds and no keys to them - it asks the user's own wallet to
 * pay - and the feature stays off until the user connects that wallet by
 * pasting its Nostr Wallet Connect string. So it is offered everywhere, and a
 * store that objects gets it hidden by name below. The distinction is about
 * the store rather than the device, which is why a browser is `web` even on
 * an iPhone: nobody using Safari went through a store review.
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
 * Where a store's review has ruled the connected wallet out. Empty: none has.
 * Adding a platform closes both the menu entry and the route there.
 */
const WALLET_HIDDEN_ON: ReadonlySet<Platform> = new Set<Platform>();

/**
 * True where a connected Lightning wallet must not be offered.
 *
 * Zapping is unaffected: without a wallet the zap composer shows the invoice
 * as a QR code, which is a payment request rather than a wallet, and is how
 * zapping worked before wallet support existed.
 */
export function hidesWallet(): boolean {
  return WALLET_HIDDEN_ON.has(currentPlatform());
}
