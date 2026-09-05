import * as QRCode from 'qrcode';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';
import { getWalletConnection } from '../features/wallet/wallet-store.js';
import { signWithSession } from './signer.js';
import { requestZapInvoice, type ZapInvoice } from './zap-request.js';

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

function _bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte: number): string => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function signZapRequest(
  unsignedEvent: Omit<NostrEvent, 'id' | 'sig'>,
  options: ZapOverlayOptions,
): Promise<NostrEvent> {
  const _nostr: WindowWithNostrAndWebLn['nostr'] = (
    window as WindowWithNostrAndWebLn
  ).nostr;
  return signWithSession(unsignedEvent);
}

/**
 * The web's half of a zap: who is signing, and which relays to name.
 *
 * Everything else - the LNURL lookup, the request, the invoice and its checks
 * - is in `zap-request.ts`, shared with the phone. Only the view differs.
 */
async function buildZapInvoice(
  context: ZapContext,
  amountSats: number,
  comment: string,
  options: ZapOverlayOptions,
): Promise<ZapInvoice> {
  const storedPubkey: PubkeyHex | null = getStoredPubkey();
  if (!storedPubkey) {
    throw new Error('Sign-in required to send a zap.');
  }

  return requestZapInvoice({
    senderPubkey: storedPubkey,
    recipientPubkey: context.recipientPubkey,
    recipientProfile: context.recipientProfile,
    ...(context.targetType === 'event' && context.event
      ? { event: context.event }
      : {}),
    amountSats,
    comment,
    relays: options.getRelays(),
    sign: (event) => signZapRequest(event, options),
  });
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
  // A connected NWC wallet is tried first. WebLN needs a browser extension,
  // which does not exist on mobile, so on the app it is the only route that
  // can actually pay without leaving for another app.
  const connection = getWalletConnection();
  if (connection) {
    try {
      const { payInvoice: payViaNwc } = await import(
        '../features/wallet/nwc-client.js'
      );
      const result = await payViaNwc(connection, invoice);
      return { verified: Boolean(result.preimage) };
    } catch (error: unknown) {
      // Fall through to WebLN and the QR code rather than dead-ending: the
      // wallet may be offline while another route still works.
      console.warn('[zap] Wallet payment failed:', error);
    }
  }

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
      const { invoice, validation } = await buildZapInvoice(
        currentZapContext,
        amountSats,
        commentInput.value,
        options,
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
      } else if (validation.warning) {
        statusEl.textContent = validation.warning;
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
