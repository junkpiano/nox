import { bech32 } from '@scure/base';
import { finalizeEvent, nip57 } from 'nostr-tools';
import * as QRCode from 'qrcode';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';

interface ZapOverlayOptions {
  getSessionPrivateKey: () => Uint8Array | null;
  getRelays: () => string[];
}

interface ZapContext {
  targetType: 'event' | 'profile';
  recipientPubkey: PubkeyHex;
  recipientName: string;
  recipientProfile: NostrProfile | null;
  event?: NostrEvent;
}

interface ZapPayInfo {
  callback: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed?: number;
  allowsNostr?: boolean;
  metadata?: string;
  nostrPubkey?: string;
}

interface ZapInvoiceResponse {
  pr?: string;
  reason?: string;
  status?: string;
}

interface WindowWithNostrAndWebLn extends Window {
  nostr?: {
    signEvent: (event: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
  };
  webln?: {
    enable?: () => Promise<void>;
    payInvoice?: (invoice: string) => Promise<unknown>;
    sendPayment?: (invoice: string) => Promise<unknown>;
  };
}

interface WebLnPaymentResult {
  verified: boolean;
}

interface ParsedBolt11Invoice {
  amountSats: number;
  description?: string;
  purposeCommitHash?: string;
}

interface InvoiceValidationResult {
  canAutoPay: boolean;
  warningMessage?: string;
}

let currentZapContext: ZapContext | null = null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getStoredPubkey(): PubkeyHex | null {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  return storedPubkey ? (storedPubkey as PubkeyHex) : null;
}

function canSignZapRequest(options: ZapOverlayOptions): boolean {
  const nostr: WindowWithNostrAndWebLn['nostr'] = (
    window as WindowWithNostrAndWebLn
  ).nostr;
  return Boolean(nostr?.signEvent || options.getSessionPrivateKey());
}

function getZapIdentifier(profile: NostrProfile | null): string | null {
  if (!profile) {
    return null;
  }
  if (typeof profile.lud16 === 'string' && profile.lud16.trim()) {
    return profile.lud16.trim();
  }
  if (typeof profile.lud06 === 'string' && profile.lud06.trim()) {
    return profile.lud06.trim();
  }
  return null;
}

function resolveLnurl(profile: NostrProfile | null): string | null {
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
      const lud06: `${string}1${string}` =
        profile.lud06.trim() as `${string}1${string}`;
      const decoded = bech32.decode(lud06, 1000);
      const data: Uint8Array = new Uint8Array(bech32.fromWords(decoded.words));
      return new TextDecoder().decode(data);
    } catch (error: unknown) {
      console.warn('[Zap] Failed to decode lud06:', error);
    }
  }

  return null;
}

async function fetchZapPayInfo(
  profile: NostrProfile | null,
): Promise<ZapPayInfo> {
  const lnurl: string | null = resolveLnurl(profile);
  if (!lnurl) {
    throw new Error('Recipient does not have a Lightning address configured.');
  }

  const response: Response = await fetch(lnurl);
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

async function sha256Hex(value: string): Promise<string> {
  const bytes: Uint8Array = new TextEncoder().encode(value);
  const digest: ArrayBuffer = await crypto.subtle.digest(
    'SHA-256',
    bytes as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte: number): string => byte.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte: number): string => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseBolt11Invoice(invoice: string): ParsedBolt11Invoice {
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

async function validateInvoiceForZap(
  invoice: string,
  requestedAmountSats: number,
  payInfo: ZapPayInfo,
  zapRequestJson: string,
): Promise<InvoiceValidationResult> {
  const decoded: ParsedBolt11Invoice = parseBolt11Invoice(invoice);
  if (decoded.amountSats !== requestedAmountSats) {
    throw new Error('Invoice amount does not match the requested zap amount.');
  }

  const invoiceMetadataHash: string | undefined = decoded.purposeCommitHash;
  const invoiceDescription: string | undefined = decoded.description;
  const expectedZapRequestHash: string = await sha256Hex(zapRequestJson);
  const expectedMetadataHash: string | null = payInfo.metadata
    ? await sha256Hex(payInfo.metadata)
    : null;

  if (invoiceMetadataHash) {
    if (
      invoiceMetadataHash !== expectedZapRequestHash &&
      invoiceMetadataHash !== expectedMetadataHash
    ) {
      throw new Error(
        'Invoice description hash does not match the zap request or LNURL response.',
      );
    }
    return { canAutoPay: true };
  }

  if (invoiceDescription) {
    if (
      invoiceDescription !== zapRequestJson &&
      invoiceDescription !== payInfo.metadata
    ) {
      return {
        canAutoPay: false,
        warningMessage:
          'Invoice created, but its plain-text description differs from the zap request. Auto-pay was disabled; pay manually if you trust this recipient.',
      };
    }
  }

  return { canAutoPay: true };
}

async function signZapRequest(
  unsignedEvent: Omit<NostrEvent, 'id' | 'sig'>,
  options: ZapOverlayOptions,
): Promise<NostrEvent> {
  const nostr: WindowWithNostrAndWebLn['nostr'] = (
    window as WindowWithNostrAndWebLn
  ).nostr;
  if (nostr?.signEvent) {
    return await nostr.signEvent(unsignedEvent);
  }

  const privateKey: Uint8Array | null = options.getSessionPrivateKey();
  if (!privateKey) {
    throw new Error('No signing method available.');
  }
  return finalizeEvent(unsignedEvent, privateKey) as NostrEvent;
}

async function requestZapInvoice(
  context: ZapContext,
  amountSats: number,
  comment: string,
  options: ZapOverlayOptions,
): Promise<{ invoice: string; payInfo: ZapPayInfo; zapRequestJson: string }> {
  const storedPubkey: PubkeyHex | null = getStoredPubkey();
  if (!storedPubkey) {
    throw new Error('Sign-in required to send a zap.');
  }

  const payInfo: ZapPayInfo = await fetchZapPayInfo(context.recipientProfile);
  const amountMsats: number = amountSats * 1000;
  if (amountMsats < payInfo.minSendable || amountMsats > payInfo.maxSendable) {
    const minSats: number = Math.ceil(payInfo.minSendable / 1000);
    const maxSats: number = Math.floor(payInfo.maxSendable / 1000);
    throw new Error(`Amount must be between ${minSats} and ${maxSats} sats.`);
  }

  const trimmedComment: string = comment.trim();
  const commentAllowed: number = Math.max(0, payInfo.commentAllowed || 0);
  if (trimmedComment && commentAllowed === 0) {
    throw new Error('Recipient does not accept zap comments.');
  }
  if (trimmedComment && trimmedComment.length > commentAllowed) {
    throw new Error(
      `Comment is too long. Limit: ${commentAllowed} characters.`,
    );
  }

  const zapTemplate =
    context.targetType === 'event' && context.event
      ? nip57.makeZapRequest({
          event: context.event,
          amount: amountMsats,
          comment: trimmedComment,
          relays: options.getRelays(),
        })
      : nip57.makeZapRequest({
          pubkey: context.recipientPubkey,
          amount: amountMsats,
          comment: trimmedComment,
          relays: options.getRelays(),
        });

  const signedZapRequest: NostrEvent = await signZapRequest(
    {
      ...zapTemplate,
      pubkey: storedPubkey,
    },
    options,
  );
  const zapRequestJson: string = JSON.stringify(signedZapRequest);

  const callbackUrl: URL = new URL(payInfo.callback);
  callbackUrl.searchParams.set('amount', amountMsats.toString());
  callbackUrl.searchParams.set('nostr', zapRequestJson);
  if (trimmedComment && commentAllowed > 0) {
    callbackUrl.searchParams.set('comment', trimmedComment);
  }

  const invoiceResponse: Response = await fetch(callbackUrl.toString());
  if (!invoiceResponse.ok) {
    throw new Error(
      `Failed to create invoice: ${invoiceResponse.status} ${invoiceResponse.statusText}`,
    );
  }

  const invoiceData: ZapInvoiceResponse = await invoiceResponse.json();
  if (invoiceData.status === 'ERROR') {
    throw new Error(invoiceData.reason || 'Zap invoice request failed.');
  }
  if (!invoiceData.pr) {
    throw new Error('Zap endpoint did not return a Lightning invoice.');
  }

  return {
    invoice: invoiceData.pr,
    payInfo,
    zapRequestJson,
  };
}

function extractPaymentPreimage(result: unknown): string | null {
  if (typeof result === 'string' && /^[0-9a-f]{64}$/i.test(result)) {
    return result;
  }
  if (!result || typeof result !== 'object') {
    return null;
  }

  const candidateKeys: string[] = ['preimage', 'paymentPreimage'];
  for (const key of candidateKeys) {
    const value: unknown = (result as Record<string, unknown>)[key];
    if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) {
      return value;
    }
  }
  return null;
}

async function payInvoice(invoice: string): Promise<WebLnPaymentResult> {
  const webln: WindowWithNostrAndWebLn['webln'] = (
    window as WindowWithNostrAndWebLn
  ).webln;
  if (!webln) {
    return { verified: false };
  }

  if (typeof webln.enable === 'function') {
    await webln.enable();
  }
  if (typeof webln.sendPayment === 'function') {
    const result: unknown = await webln.sendPayment(invoice);
    return { verified: Boolean(extractPaymentPreimage(result)) };
  }
  if (typeof webln.payInvoice === 'function') {
    const result: unknown = await webln.payInvoice(invoice);
    return { verified: Boolean(extractPaymentPreimage(result)) };
  }

  return { verified: false };
}

function setInvoiceActions(
  invoice: string,
  invoiceBox: HTMLElement,
  invoiceText: HTMLTextAreaElement,
  lightningLink: HTMLAnchorElement,
  submitBtn: HTMLButtonElement,
  showWalletLink: boolean,
): void {
  const lightningUri: string = `lightning:${invoice}`;
  invoiceText.value = invoice;
  lightningLink.href = lightningUri;
  lightningLink.style.display = showWalletLink ? '' : 'none';
  invoiceBox.style.display = '';
  submitBtn.style.display = 'none';
}

function resetInvoiceState(
  invoiceBox: HTMLElement,
  invoiceQr: HTMLImageElement,
  invoiceText: HTMLTextAreaElement,
  submitBtn: HTMLButtonElement,
  lightningLink: HTMLAnchorElement,
): void {
  invoiceBox.style.display = 'none';
  invoiceQr.src = '';
  invoiceText.value = '';
  lightningLink.style.display = '';
  submitBtn.style.display = '';
}

export function openZapComposer(context: ZapContext): void {
  window.dispatchEvent(
    new CustomEvent<ZapContext>('open-zap', { detail: context }),
  );
}

export function setupZapOverlay(options: ZapOverlayOptions): void {
  const overlay: HTMLElement | null = document.getElementById('zap-overlay');
  const backdrop: HTMLElement | null = document.getElementById(
    'zap-overlay-backdrop',
  );
  const closeBtn: HTMLElement | null =
    document.getElementById('zap-overlay-close');
  const titleEl: HTMLElement | null = document.getElementById('zap-title');
  const targetEl: HTMLElement | null = document.getElementById('zap-target');
  const amountInput: HTMLInputElement | null = document.getElementById(
    'zap-amount',
  ) as HTMLInputElement | null;
  const commentInput: HTMLTextAreaElement | null = document.getElementById(
    'zap-comment',
  ) as HTMLTextAreaElement | null;
  const submitBtn: HTMLButtonElement | null = document.getElementById(
    'zap-submit',
  ) as HTMLButtonElement | null;
  const statusEl: HTMLElement | null = document.getElementById('zap-status');
  const invoiceBox: HTMLElement | null = document.getElementById('zap-invoice');
  const invoiceText: HTMLTextAreaElement | null = document.getElementById(
    'zap-invoice-text',
  ) as HTMLTextAreaElement | null;
  const invoiceQr: HTMLImageElement | null = document.getElementById(
    'zap-invoice-qr',
  ) as HTMLImageElement | null;
  const copyInvoiceBtn: HTMLButtonElement | null = document.getElementById(
    'zap-copy-invoice',
  ) as HTMLButtonElement | null;
  const lightningLink: HTMLAnchorElement | null = document.getElementById(
    'zap-open-wallet',
  ) as HTMLAnchorElement | null;
  const presetButtons: NodeListOf<HTMLButtonElement> =
    document.querySelectorAll('[data-zap-amount]');

  if (
    !overlay ||
    !backdrop ||
    !closeBtn ||
    !titleEl ||
    !targetEl ||
    !amountInput ||
    !commentInput ||
    !submitBtn ||
    !statusEl ||
    !invoiceBox ||
    !invoiceText ||
    !invoiceQr ||
    !copyInvoiceBtn ||
    !lightningLink
  ) {
    return;
  }

  let isSubmitting: boolean = false;

  const refreshStatus = (): void => {
    if (isSubmitting) {
      submitBtn.disabled = true;
      submitBtn.classList.add('opacity-60', 'cursor-not-allowed');
      return;
    }

    submitBtn.disabled = false;
    submitBtn.classList.remove('opacity-60', 'cursor-not-allowed');
  };

  const closeOverlay = (): void => {
    overlay.style.display = 'none';
    statusEl.textContent = '';
    resetInvoiceState(
      invoiceBox,
      invoiceQr,
      invoiceText,
      submitBtn,
      lightningLink,
    );
    commentInput.value = '';
    currentZapContext = null;
  };

  const openOverlay = (context: ZapContext): void => {
    currentZapContext = context;
    overlay.style.display = '';
    titleEl.textContent =
      context.targetType === 'event' ? 'Zap Post' : 'Zap Profile';
    const zapIdentifier: string | null = getZapIdentifier(
      context.recipientProfile,
    );
    targetEl.innerHTML = `
      <div class="text-sm font-semibold text-gray-900">${escapeHtml(context.recipientName)}</div>
      ${
        zapIdentifier
          ? `<div class="text-xs text-gray-500 mt-1">${escapeHtml(zapIdentifier)}</div>`
          : '<div class="text-xs text-amber-700 mt-1">No Lightning address found in profile metadata.</div>'
      }
    `;
    amountInput.value = amountInput.value || '21';
    commentInput.value = '';
    resetInvoiceState(
      invoiceBox,
      invoiceQr,
      invoiceText,
      submitBtn,
      lightningLink,
    );
    statusEl.textContent = canSignZapRequest(options)
      ? 'Sign zap request here, pay invoice with your wallet.'
      : 'Sign-in required to create a zap request.';
    refreshStatus();
    amountInput.focus();
    amountInput.select();
  };

  window.addEventListener('open-zap', ((event: CustomEvent<ZapContext>) => {
    openOverlay(event.detail);
  }) as EventListener);

  backdrop.addEventListener('click', closeOverlay);
  closeBtn.addEventListener('click', closeOverlay);

  presetButtons.forEach((button: HTMLButtonElement): void => {
    button.addEventListener('click', (): void => {
      const value: string | null = button.getAttribute('data-zap-amount');
      if (!value) {
        return;
      }
      amountInput.value = value;
      resetZapDraft();
      amountInput.focus();
      amountInput.select();
    });
  });

  const resetZapDraft = (): void => {
    if (invoiceBox.style.display === 'none') {
      return;
    }
    resetInvoiceState(
      invoiceBox,
      invoiceQr,
      invoiceText,
      submitBtn,
      lightningLink,
    );
    statusEl.textContent = canSignZapRequest(options)
      ? 'Sign zap request here, pay invoice with your wallet.'
      : 'Sign-in required to create a zap request.';
  };

  amountInput.addEventListener('input', resetZapDraft);
  commentInput.addEventListener('input', resetZapDraft);

  submitBtn.addEventListener('click', async (): Promise<void> => {
    if (!currentZapContext) {
      statusEl.textContent = 'Zap target missing. Please try again.';
      return;
    }
    if (!canSignZapRequest(options)) {
      statusEl.textContent = 'Sign-in required to create a zap request.';
      alert('Sign in with an extension or private key to send zaps.');
      return;
    }

    const amountSats: number = Math.floor(Number(amountInput.value));
    if (!Number.isFinite(amountSats) || amountSats <= 0) {
      statusEl.textContent = 'Enter a valid amount in sats.';
      amountInput.focus();
      return;
    }

    isSubmitting = true;
    refreshStatus();
    resetInvoiceState(
      invoiceBox,
      invoiceQr,
      invoiceText,
      submitBtn,
      lightningLink,
    );
    statusEl.textContent = 'Creating Lightning invoice...';

    try {
      const { invoice, payInfo, zapRequestJson } = await requestZapInvoice(
        currentZapContext,
        amountSats,
        commentInput.value,
        options,
      );
      const validation: InvoiceValidationResult = await validateInvoiceForZap(
        invoice,
        amountSats,
        payInfo,
        zapRequestJson,
      );
      const qrCodeDataUrl: string = await QRCode.toDataURL(
        `lightning:${invoice}`,
        {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 320,
        },
      );
      invoiceQr.src = qrCodeDataUrl;
      const webLnPayment: WebLnPaymentResult = validation.canAutoPay
        ? await payInvoice(invoice)
        : { verified: false };
      setInvoiceActions(
        invoice,
        invoiceBox,
        invoiceText,
        lightningLink,
        submitBtn,
        !webLnPayment.verified,
      );
      if (webLnPayment.verified) {
        statusEl.textContent =
          'Payment verified by wallet response. Zap receipt may appear shortly.';
      } else if (validation.warningMessage) {
        statusEl.textContent = validation.warningMessage;
      } else if ((window as WindowWithNostrAndWebLn).webln) {
        statusEl.textContent =
          'Invoice validated, but wallet payment could not be verified. Scan the QR or use Open wallet to complete manually.';
      } else {
        statusEl.textContent =
          'Invoice ready. Scan the QR code or open it in your Lightning wallet.';
      }
    } catch (error: unknown) {
      console.error('[Zap] Failed to create zap:', error);
      resetInvoiceState(
        invoiceBox,
        invoiceQr,
        invoiceText,
        submitBtn,
        lightningLink,
      );
      statusEl.textContent =
        error instanceof Error ? error.message : 'Failed to create zap.';
    } finally {
      isSubmitting = false;
      refreshStatus();
    }
  });

  copyInvoiceBtn.addEventListener('click', async (): Promise<void> => {
    if (!invoiceText.value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(invoiceText.value);
      statusEl.textContent = 'Invoice copied to clipboard.';
    } catch (error: unknown) {
      console.error('[Zap] Failed to copy invoice:', error);
      statusEl.textContent = 'Failed to copy invoice.';
    }
  });
}
