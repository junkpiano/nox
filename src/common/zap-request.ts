/**
 * NIP-57, up to the invoice.
 *
 * Everything here is the protocol half of a zap: finding the recipient's
 * LNURL endpoint, asking it what it will accept, signing a kind:9734 request,
 * exchanging that for a bolt11 invoice, and checking that the invoice actually
 * corresponds to the request. Paying it is somebody else's problem - a browser
 * has WebLN, a phone has NWC, and neither belongs in here.
 *
 * The checks are not decoration. The invoice comes back from a server the
 * recipient named, and paying a Lightning invoice cannot be undone: an amount
 * that does not match what was asked for, or a description hash that commits
 * to something other than the zap request, means the thing about to be paid is
 * not the thing that was agreed.
 *
 * Hashing goes through `@noble/hashes` rather than `crypto.subtle`, which
 * React Native does not have. The library is already here as a dependency of
 * nostr-tools, and it is synchronous, which removes an await from the middle
 * of a validation.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { nip57 } from 'nostr-tools';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';
import { crossOriginFetch } from './native-http.js';

export interface ZapPayInfo {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata?: string;
  commentAllowed?: number;
  allowsNostr?: boolean;
  nostrPubkey?: string;
}

interface ZapInvoiceResponse {
  pr?: string;
  status?: string;
  reason?: string;
}

export interface ParsedBolt11Invoice {
  amountSats: number | null;
  description?: string;
  purposeCommitHash?: string;
}

export interface InvoiceValidation {
  /**
   * Whether a connected wallet may pay this without being asked again.
   *
   * False is not "invalid" - it is "we could not prove this is what you asked
   * for", which is a decision for the person, not for the app.
   */
  canAutoPay: boolean;
  warning?: string;
}

/** Where to ask about zapping this person, from their kind:0. */
export function resolveLnurl(profile: NostrProfile | null): string | null {
  if (!profile) {
    return null;
  }

  if (typeof profile.lud16 === 'string' && profile.lud16.includes('@')) {
    const [name, domain] = profile.lud16.trim().split('@');
    if (name && domain) {
      return new URL(
        `/.well-known/lnurlp/${name}`,
        `https://${domain}`,
      ).toString();
    }
  }

  if (typeof profile.lud06 === 'string' && profile.lud06.trim()) {
    try {
      const decoded = bech32.decode(
        profile.lud06.trim() as `${string}1${string}`,
        1000,
      );
      const data: Uint8Array = new Uint8Array(bech32.fromWords(decoded.words));
      return new TextDecoder().decode(data);
    } catch (error: unknown) {
      console.warn('[zap] Failed to decode lud06:', error);
    }
  }

  return null;
}

export function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

export async function fetchZapPayInfo(
  profile: NostrProfile | null,
): Promise<ZapPayInfo> {
  const lnurl: string | null = resolveLnurl(profile);
  if (!lnurl) {
    throw new Error('Recipient does not have a Lightning address configured.');
  }

  const response: Response = await crossOriginFetch(lnurl);
  if (!response.ok) {
    throw new Error(
      `Failed to load zap endpoint: ${response.status} ${response.statusText}`,
    );
  }

  const data: ZapPayInfo & { reason?: string; status?: string } =
    await response.json();
  if (data.status === 'ERROR') {
    throw new Error(data.reason || 'Recipient zap endpoint returned an error.');
  }
  if (!data.callback || !data.allowsNostr || !data.nostrPubkey) {
    throw new Error('Recipient does not support NIP-57 zaps.');
  }
  if (
    !Number.isFinite(data.minSendable) ||
    !Number.isFinite(data.maxSendable) ||
    data.minSendable <= 0 ||
    data.maxSendable < data.minSendable
  ) {
    throw new Error('Recipient zap endpoint returned invalid amount limits.');
  }
  return data;
}

/**
 * Reads the amount and the description fields out of a bolt11 invoice.
 *
 * Only the tagged fields this needs: 13 is the description, 23 is the hash it
 * commits to. Everything else is skipped by length, which is also why a
 * malformed field stops the walk instead of throwing - a field this does not
 * understand is not a reason to refuse the invoice.
 */
export function parseBolt11Invoice(invoice: string): ParsedBolt11Invoice {
  const decoded = bech32.decode(invoice as `${string}1${string}`, 5000);
  const words: number[] = decoded.words;
  if (words.length <= 111) {
    throw new Error('Invoice is too short to be valid.');
  }

  const invoiceWords: number[] = words.slice(0, -104);
  if (invoiceWords.length < 7) {
    throw new Error('Invoice is missing tagged fields.');
  }

  const taggedFields: number[] = invoiceWords.slice(7);
  const parsed: ParsedBolt11Invoice = {
    amountSats: nip57.getSatoshisAmountFromBolt11(invoice),
  };

  let cursor: number = 0;
  while (cursor + 3 <= taggedFields.length) {
    const type: number | undefined = taggedFields[cursor];
    const lengthHigh: number | undefined = taggedFields[cursor + 1];
    const lengthLow: number | undefined = taggedFields[cursor + 2];
    if (
      type === undefined ||
      lengthHigh === undefined ||
      lengthLow === undefined
    ) {
      break;
    }
    const dataLength: number = (lengthHigh << 5) + lengthLow;
    const start: number = cursor + 3;
    const end: number = start + dataLength;
    if (end > taggedFields.length) {
      break;
    }

    const fieldWords: number[] = taggedFields.slice(start, end);
    const rawFieldBytes: unknown = bech32.fromWordsUnsafe(fieldWords);
    if (!(rawFieldBytes instanceof Uint8Array)) {
      cursor = end;
      continue;
    }
    const fieldBytes: Uint8Array = new Uint8Array(rawFieldBytes);

    if (type === 13) {
      parsed.description = new TextDecoder().decode(fieldBytes);
    } else if (type === 23) {
      parsed.purposeCommitHash = bytesToHex(fieldBytes);
    }

    cursor = end;
  }

  return parsed;
}

/**
 * Judging an already-parsed invoice.
 *
 * Split from the parsing so the decision table can be tested without a real
 * bolt11, which cannot be written by hand.
 *
 * The amount is the part that protects the money, and a mismatch is refused
 * outright. The description hash is weaker than it looks: NIP-57 asks the
 * server to commit to the zap request as it received it, and servers in the
 * wild commit to a re-serialised copy instead - primal does, which is provable
 * from outside this app. Refusing those would mean refusing to zap a large
 * part of the network.
 *
 * So a hash that cannot be reproduced is reported as "not verified" rather
 * than "wrong": the invoice is shown, nothing is paid automatically, and the
 * person decides. Treating unverifiable as invalid breaks zapping; treating it
 * as fine would auto-pay an invoice nobody checked.
 */
export function judgeInvoice(
  parsed: ParsedBolt11Invoice,
  requestedAmountSats: number,
  payInfo: ZapPayInfo,
  zapRequestJson: string,
): InvoiceValidation {
  if (parsed.amountSats !== requestedAmountSats) {
    throw new Error('Invoice amount does not match the requested zap amount.');
  }

  const expectedZapRequestHash: string = sha256Hex(zapRequestJson);
  const expectedMetadataHash: string | null = payInfo.metadata
    ? sha256Hex(payInfo.metadata)
    : null;

  if (parsed.purposeCommitHash) {
    if (
      parsed.purposeCommitHash === expectedZapRequestHash ||
      parsed.purposeCommitHash === expectedMetadataHash
    ) {
      return { canAutoPay: true };
    }
    return {
      canAutoPay: false,
      warning:
        'The invoice is for the right amount, but its description hash could ' +
        'not be matched to the zap request. Pay it by hand if you trust this ' +
        'recipient.',
    };
  }

  if (parsed.description) {
    if (
      parsed.description !== zapRequestJson &&
      parsed.description !== payInfo.metadata
    ) {
      return {
        canAutoPay: false,
        warning:
          'The invoice is for the right amount, but its description differs ' +
          'from the zap request. Pay it by hand if you trust this recipient.',
      };
    }
  }

  return { canAutoPay: true };
}

/** Parses the invoice and judges it. */
export function validateInvoiceForZap(
  invoice: string,
  requestedAmountSats: number,
  payInfo: ZapPayInfo,
  zapRequestJson: string,
): InvoiceValidation {
  return judgeInvoice(
    parseBolt11Invoice(invoice),
    requestedAmountSats,
    payInfo,
    zapRequestJson,
  );
}

export interface ZapInvoiceRequest {
  senderPubkey: PubkeyHex;
  recipientPubkey: PubkeyHex;
  recipientProfile: NostrProfile | null;
  /** Present when zapping a post rather than a person. */
  event?: NostrEvent;
  amountSats: number;
  comment: string;
  relays: string[];
  /** However this build signs: an extension, or a key in the session. */
  sign: (event: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
}

export interface ZapInvoice {
  invoice: string;
  payInfo: ZapPayInfo;
  zapRequestJson: string;
  validation: InvoiceValidation;
}

/** Signs a zap request and exchanges it for an invoice. */
export async function requestZapInvoice(
  request: ZapInvoiceRequest,
): Promise<ZapInvoice> {
  const payInfo: ZapPayInfo = await fetchZapPayInfo(request.recipientProfile);
  const amountMsats: number = request.amountSats * 1000;
  if (amountMsats < payInfo.minSendable || amountMsats > payInfo.maxSendable) {
    const minSats: number = Math.ceil(payInfo.minSendable / 1000);
    const maxSats: number = Math.floor(payInfo.maxSendable / 1000);
    throw new Error(`Amount must be between ${minSats} and ${maxSats} sats.`);
  }

  const comment: string = request.comment.trim();
  const commentAllowed: number = Math.max(0, payInfo.commentAllowed || 0);
  if (comment && commentAllowed === 0) {
    throw new Error('Recipient does not accept zap comments.');
  }
  if (comment && comment.length > commentAllowed) {
    throw new Error(
      `Comment is too long. Limit: ${commentAllowed} characters.`,
    );
  }

  const template = request.event
    ? nip57.makeZapRequest({
        event: request.event,
        amount: amountMsats,
        comment,
        relays: request.relays,
      })
    : nip57.makeZapRequest({
        pubkey: request.recipientPubkey,
        amount: amountMsats,
        comment,
        relays: request.relays,
      });

  const signed: NostrEvent = await request.sign({
    ...template,
    pubkey: request.senderPubkey,
  });
  const zapRequestJson: string = JSON.stringify(signed);

  const callbackUrl: URL = new URL(payInfo.callback);
  callbackUrl.searchParams.set('amount', amountMsats.toString());
  callbackUrl.searchParams.set('nostr', zapRequestJson);
  if (comment && commentAllowed > 0) {
    callbackUrl.searchParams.set('comment', comment);
  }

  const response: Response = await crossOriginFetch(callbackUrl.toString());
  if (!response.ok) {
    throw new Error(
      `Failed to create invoice: ${response.status} ${response.statusText}`,
    );
  }

  const data: ZapInvoiceResponse = await response.json();
  if (data.status === 'ERROR') {
    throw new Error(data.reason || 'Zap invoice request failed.');
  }
  if (!data.pr) {
    throw new Error('Zap endpoint did not return a Lightning invoice.');
  }

  return {
    invoice: data.pr,
    payInfo,
    zapRequestJson,
    validation: validateInvoiceForZap(
      data.pr,
      request.amountSats,
      payInfo,
      zapRequestJson,
    ),
  };
}
