import { finalizeEvent } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr';
import { storeEvent } from './db/index.js';

interface ReplyOverlayOptions {
  getSessionPrivateKey: () => Uint8Array | null;
  getRelays: () => string[];
  publishEvent: (event: NostrEvent, relays: string[]) => Promise<void>;
  refreshTimeline: () => Promise<void>;
}

interface ReplyContext {
  eventId: string;
  eventPubkey: string;
  eventAuthor: string;
  eventContent: string;
}

let currentReplyContext: ReplyContext | null = null;

export function setupReplyOverlay(options: ReplyOverlayOptions): void {
  const overlay: HTMLElement | null = document.getElementById('reply-overlay');
  const backdrop: HTMLElement | null = document.getElementById(
    'reply-overlay-backdrop',
  );
  const closeBtn: HTMLElement | null = document.getElementById(
    'reply-overlay-close',
  );
  const textarea: HTMLTextAreaElement | null = document.getElementById(
    'reply-textarea',
  ) as HTMLTextAreaElement;
  const submitBtn: HTMLButtonElement | null = document.getElementById(
    'reply-submit',
  ) as HTMLButtonElement;
  const statusEl: HTMLElement | null = document.getElementById('reply-status');
  const originalPostEl: HTMLElement | null = document.getElementById(
    'reply-original-post',
  );

  if (
    !overlay ||
    !backdrop ||
    !closeBtn ||
    !textarea ||
    !submitBtn ||
    !statusEl ||
    !originalPostEl
  ) {
    return;
  }

  const openOverlay = (context: ReplyContext): void => {
    currentReplyContext = context;

    // Display the original post
    const truncatedContent =
      context.eventContent.length > 200
        ? `${context.eventContent.substring(0, 200)}...`
        : context.eventContent;

    originalPostEl.innerHTML = `
      <div class="text-xs text-gray-600 mb-1">Replying to <span class="font-semibold">${escapeHtml(context.eventAuthor)}</span></div>
      <div class="text-sm text-gray-800 whitespace-pre-wrap break-words">${escapeHtml(truncatedContent)}</div>
    `;

    overlay.style.display = '';
    document.body.classList.add('overflow-hidden');
    textarea.value = '';
    textarea.focus();
    refreshStatus();
  };

  const closeOverlay = (): void => {
    overlay.style.display = 'none';
    document.body.classList.remove('overflow-hidden');
    statusEl.textContent = '';
    currentReplyContext = null;
    textarea.value = '';
  };

  const refreshStatus = (): void => {
    const hasExtension: boolean = Boolean((window as any).nostr?.signEvent);
    const hasPrivateKey: boolean = Boolean(options.getSessionPrivateKey());

    if (hasExtension) {
      statusEl.textContent = 'Signing with extension';
    } else if (hasPrivateKey) {
      statusEl.textContent = 'Signing with private key';
    } else {
      statusEl.textContent = 'Sign-in required to reply';
    }

    if (!hasExtension && !hasPrivateKey) {
      submitBtn.disabled = true;
      submitBtn.classList.add('opacity-60', 'cursor-not-allowed');
    } else {
      submitBtn.disabled = false;
      submitBtn.classList.remove('opacity-60', 'cursor-not-allowed');
    }
  };

  // Listen for open-reply events
  window.addEventListener('open-reply', ((event: CustomEvent) => {
    openOverlay(event.detail);
  }) as EventListener);

  backdrop.addEventListener('click', closeOverlay);
  closeBtn.addEventListener('click', closeOverlay);

  submitBtn.addEventListener('click', async (): Promise<void> => {
    if (!currentReplyContext) {
      alert('Reply context lost. Please try again.');
      closeOverlay();
      return;
    }

    const content: string = textarea.value.trim();
    if (!content) {
      alert('Reply cannot be empty');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-60', 'cursor-not-allowed');
    statusEl.textContent = 'Publishing reply...';

    try {
      const hasExtension: boolean = Boolean((window as any).nostr?.signEvent);
      const sessionPrivateKey: Uint8Array | null =
        options.getSessionPrivateKey();

      if (!hasExtension && !sessionPrivateKey) {
        throw new Error('No signing method available');
      }

      // Create reply event with proper tags
      // According to NIP-10:
      // - "e" tag with "reply" marker for the event being replied to
      // - "p" tag for the author being replied to
      const unsignedEvent: any = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', currentReplyContext.eventId, '', 'reply'],
          ['p', currentReplyContext.eventPubkey],
        ],
        content,
      };

      let signedEvent: NostrEvent;

      if (hasExtension) {
        signedEvent = await (window as any).nostr.signEvent(unsignedEvent);
      } else if (sessionPrivateKey) {
        signedEvent = finalizeEvent(unsignedEvent, sessionPrivateKey);
      } else {
        throw new Error('No signing method available');
      }

      const relays: string[] = options.getRelays();
      await options.publishEvent(signedEvent, relays);
      await storeEvent(signedEvent, { isHomeTimeline: false });

      statusEl.textContent = 'Reply published!';

      setTimeout((): void => {
        closeOverlay();
        options.refreshTimeline().catch((error: unknown): void => {
          console.error('Failed to refresh timeline:', error);
        });
      }, 1000);
    } catch (error: unknown) {
      console.error('Failed to publish reply:', error);
      statusEl.textContent = 'Failed to publish reply';
      submitBtn.disabled = false;
      submitBtn.classList.remove('opacity-60', 'cursor-not-allowed');

      if (error instanceof Error) {
        alert(`Failed to publish reply: ${error.message}`);
      } else {
        alert('Failed to publish reply. Please try again.');
      }
    }
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
