import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { withClientTag } from './client-tag.js';
import { withTopicTags } from './content-segments.js';
import { contentWarningTags } from './content-warning.js';
import { storeEvent } from './db/index.js';
import type { ImageUploadResult } from './image-upload.js';
import { uploadImage } from './image-upload.js';
import { quoteContent, quoteTags } from './quote.js';
import { signWithSession } from './signer.js';

interface ComposeOverlayOptions {
  composeButton: HTMLElement | null;
  getSessionPrivateKey: () => Uint8Array | null;
  getRelays: () => string[];
  publishEvent: (event: NostrEvent, relays: string[]) => Promise<void>;
  refreshTimeline: () => Promise<void>;
}

/** Set once the overlay is wired; the quote action opens it through this. */
let openWithQuote: ((event: NostrEvent) => void) | null = null;

/**
 * Opens the composer to quote `event` (NIP-18): the post that is written
 * ends with a `nostr:` reference to it and carries a `q` tag naming it, so
 * every client draws the quoted post as a card under the words.
 */
export function quotePost(event: NostrEvent): void {
  openWithQuote?.(event);
}

export function setupComposeOverlay(options: ComposeOverlayOptions): void {
  const overlay: HTMLElement | null =
    document.getElementById('compose-overlay');
  const backdrop: HTMLElement | null = document.getElementById(
    'compose-overlay-backdrop',
  );
  const closeBtn: HTMLElement | null = document.getElementById(
    'compose-overlay-close',
  );
  const textarea: HTMLTextAreaElement | null = document.getElementById(
    'compose-textarea',
  ) as HTMLTextAreaElement;
  const contentWarningToggle: HTMLInputElement | null = document.getElementById(
    'compose-content-warning-toggle',
  ) as HTMLInputElement | null;
  const contentWarningReason: HTMLInputElement | null = document.getElementById(
    'compose-content-warning-reason',
  ) as HTMLInputElement | null;
  const submitBtn: HTMLButtonElement | null = document.getElementById(
    'compose-submit',
  ) as HTMLButtonElement;
  const statusEl: HTMLElement | null =
    document.getElementById('compose-status');

  const imageInput: HTMLInputElement | null = document.getElementById(
    'compose-image-input',
  ) as HTMLInputElement | null;
  const imageBtn: HTMLButtonElement | null = document.getElementById(
    'compose-image-btn',
  ) as HTMLButtonElement | null;
  const imagePreview: HTMLElement | null = document.getElementById(
    'compose-image-preview',
  );
  const imagePreviewImg: HTMLImageElement | null = document.getElementById(
    'compose-image-preview-img',
  ) as HTMLImageElement | null;
  const imageRemoveBtn: HTMLButtonElement | null = document.getElementById(
    'compose-image-remove',
  ) as HTMLButtonElement | null;

  if (
    !overlay ||
    !backdrop ||
    !closeBtn ||
    !textarea ||
    !contentWarningToggle ||
    !contentWarningReason ||
    !submitBtn ||
    !statusEl
  ) {
    return;
  }
  let isSubmitting: boolean = false;
  let selectedImageFile: File | null = null;
  // The post being quoted, while the composer is open for a quote.
  let quoting: NostrEvent | null = null;
  // Which opening of the composer this is; a send that finishes after it
  // was closed (and perhaps opened again) leaves the new draft alone.
  let draftNumber: number = 0;
  const quotePreview: HTMLElement | null = document.getElementById(
    'compose-quote-preview',
  );
  const quoteText: HTMLElement | null =
    document.getElementById('compose-quote-text');
  const title: HTMLElement | null = document.getElementById('compose-title');
  const setQuoting = (event: NostrEvent | null): void => {
    quoting = event;
    if (title) title.textContent = event ? 'Quote post' : 'Create Post';
    if (quotePreview) quotePreview.hidden = event === null;
    if (quoteText) {
      // The words being quoted, on one line; the card under the post is the
      // full rendering, this only says which post it will be.
      const words: string = (event?.content ?? '').replace(/\s+/g, ' ').trim();
      quoteText.textContent =
        words.length > 140 ? `${words.slice(0, 140)}…` : words;
    }
  };
  document
    .getElementById('compose-quote-remove')
    ?.addEventListener('click', (): void => {
      setQuoting(null);
      textarea.focus();
    });
  let previewObjectUrl: string | null = null;

  const updateContentWarningReasonState = (): void => {
    const enabled: boolean = contentWarningToggle.checked;
    contentWarningReason.disabled = !enabled;
    if (!enabled) {
      contentWarningReason.value = '';
      contentWarningReason.classList.add('opacity-60', 'cursor-not-allowed');
    } else {
      contentWarningReason.classList.remove('opacity-60', 'cursor-not-allowed');
    }
  };

  const openOverlay = (): void => {
    draftNumber += 1;
    overlay.style.display = '';
    updateContentWarningReasonState();
    document.body.classList.add('overflow-hidden');
    textarea.focus();
  };
  openWithQuote = (event: NostrEvent): void => {
    setQuoting(event);
    openOverlay();
  };

  const clearSelectedImage = (): void => {
    selectedImageFile = null;
    if (imageInput) {
      imageInput.value = '';
    }
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    }
    if (imagePreview) {
      imagePreview.style.display = 'none';
    }
    if (imagePreviewImg) {
      imagePreviewImg.src = '';
    }
  };

  /**
   * One image at a time, whichever way it arrived: the file picker, or a
   * paste. Attaching a second one replaces the first, so the preview is
   * always what will be posted.
   */
  const attachImageFile = (file: File): void => {
    if (!imagePreview || !imagePreviewImg) {
      return;
    }
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
    }
    // The picker keeps the last file it handed over, and selecting that same
    // file again fires no change event - so a pasted image would survive a
    // re-pick of the earlier one and get posted instead.
    if (imageInput) {
      imageInput.value = '';
    }
    selectedImageFile = file;
    previewObjectUrl = URL.createObjectURL(file);
    imagePreviewImg.src = previewObjectUrl;
    imagePreview.style.display = '';
  };

  /**
   * The image on a clipboard, if it is carrying one.
   *
   * Bytes win over the other flavours the same copy left behind. Safari
   * hands over an image's address as text beside the image itself, and a
   * post composer is not where someone pastes an image meaning its URL.
   */
  const clipboardImage = (data: DataTransfer | null): File | null => {
    if (!data) {
      return null;
    }
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) {
        continue;
      }
      const file: File | null = item.getAsFile();
      if (file) {
        return file;
      }
    }
    return null;
  };

  const closeOverlay = (): void => {
    draftNumber += 1;
    setQuoting(null);
    overlay.style.display = 'none';
    document.body.classList.remove('overflow-hidden');
    statusEl.textContent = '';
    contentWarningToggle.checked = false;
    contentWarningReason.value = '';
    updateContentWarningReasonState();
    clearSelectedImage();
  };

  const refreshStatus = (): void => {
    const hasExtension: boolean = Boolean((window as any).nostr?.signEvent);
    const hasPrivateKey: boolean = Boolean(options.getSessionPrivateKey());
    if (hasExtension) {
      statusEl.textContent = 'Signing with extension';
    } else if (hasPrivateKey) {
      statusEl.textContent = 'Signing with private key';
    } else {
      statusEl.textContent = 'Sign-in required to post';
    }

    if (isSubmitting) {
      submitBtn.disabled = true;
      submitBtn.classList.add('opacity-60', 'cursor-not-allowed');
    } else {
      submitBtn.disabled = false;
      submitBtn.classList.remove('opacity-60', 'cursor-not-allowed');
    }
  };

  if (options.composeButton) {
    options.composeButton.addEventListener('click', (): void => {
      refreshStatus();
      openOverlay();
    });
  }

  backdrop.addEventListener('click', closeOverlay);
  closeBtn.addEventListener('click', closeOverlay);
  contentWarningToggle.addEventListener('change', (): void => {
    updateContentWarningReasonState();
  });

  if (imageBtn && imageInput) {
    imageBtn.addEventListener('click', (): void => {
      imageInput.click();
    });
  }

  if (imageInput && imagePreview && imagePreviewImg) {
    imageInput.addEventListener('change', (): void => {
      const file: File | undefined = imageInput.files?.[0];
      if (!file) {
        return;
      }
      attachImageFile(file);
    });
  }

  // On the document rather than the textarea: a paste with nothing focused
  // is delivered to the body, which is above the overlay and never sees an
  // event bubbling out of it. The open composer is what makes it ours.
  document.addEventListener('paste', (event: ClipboardEvent): void => {
    if (overlay.style.display === 'none') {
      return;
    }
    const file: File | null = clipboardImage(event.clipboardData);
    if (!file) {
      return;
    }
    // Otherwise the browser also drops the file's name into the text.
    event.preventDefault();
    attachImageFile(file);
  });

  if (imageRemoveBtn) {
    imageRemoveBtn.addEventListener('click', (): void => {
      clearSelectedImage();
    });
  }

  const isTypingContext = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const tagName: string = target.tagName.toLowerCase();
    if (
      tagName === 'input' ||
      tagName === 'textarea' ||
      target.isContentEditable
    ) {
      return true;
    }

    return false;
  };

  const canOpenCompose = (): boolean => {
    if (!options.composeButton) {
      return false;
    }
    return options.composeButton.style.display !== 'none';
  };

  document.addEventListener('keydown', (event: KeyboardEvent): void => {
    const isOverlayOpen: boolean = overlay.style.display !== 'none';

    if (isOverlayOpen && event.key === 'Escape') {
      closeOverlay();
      return;
    }

    if (
      !isOverlayOpen &&
      event.key.toLowerCase() === 'n' &&
      !isTypingContext(event.target)
    ) {
      if (!canOpenCompose()) {
        return;
      }
      event.preventDefault();
      refreshStatus();
      openOverlay();
      return;
    }

    if (
      isOverlayOpen &&
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      if (!submitBtn.disabled) {
        submitBtn.click();
      }
    }
  });

  submitBtn.addEventListener('click', async (): Promise<void> => {
    // A quote with no words of its own is still a post: it says "this".
    if (!textarea.value.trim() && !selectedImageFile && !quoting) {
      textarea.focus();
      return;
    }

    const hasExtension: boolean = Boolean((window as any).nostr?.signEvent);
    const privateKey: Uint8Array | null = options.getSessionPrivateKey();
    if (!hasExtension && !privateKey) {
      statusEl.textContent = 'Sign-in required to post';
      alert(
        'Sign-in required to post. Please log in with extension or private key.',
      );
      refreshStatus();
      return;
    }

    isSubmitting = true;
    refreshStatus();
    // Everything this post says is fixed now: the upload below takes time,
    // and the composer may be closed and opened for another post meanwhile.
    const quoted: NostrEvent | null = quoting;
    const text: string = textarea.value.trim();
    const warned: boolean = contentWarningToggle.checked;
    const warningReason: string = contentWarningReason.value;
    const imageFile: File | null = selectedImageFile;
    const draft: number = draftNumber;

    try {
      const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
      if (!storedPubkey) {
        throw new Error('Not logged in');
      }

      let imageUrl: string | null = null;
      if (imageFile) {
        statusEl.textContent = 'Uploading image...';
        const result: ImageUploadResult = await uploadImage(
          imageFile,
          storedPubkey as PubkeyHex,
          options.getSessionPrivateKey,
        );
        imageUrl = result.url;
      }

      statusEl.textContent = 'Posting...';

      const tags: string[][] = [
        ...(warned ? contentWarningTags(warningReason) : []),
        ...(quoted ? quoteTags(quoted) : []),
      ];

      // Words, then the picture, then the quoted post: each on its own line.
      const parts: string[] = [text, imageUrl ?? ''];
      const content: string = quoted
        ? quoteContent(parts, quoted)
        : parts.filter((part: string): boolean => part.length > 0).join('\n\n');

      const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = withClientTag({
        kind: 1,
        pubkey: storedPubkey as PubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: withTopicTags(content, tags),
        content,
      });

      const signedEvent: NostrEvent = await signWithSession(unsignedEvent);

      await options.publishEvent(signedEvent, options.getRelays());
      await storeEvent(signedEvent, { isHomeTimeline: false });
      // A newer draft opened while this was sending is someone else's work:
      // only the composer this post came from is cleared and closed.
      if (draft !== draftNumber) {
        await options.refreshTimeline();
        return;
      }
      textarea.value = '';
      contentWarningToggle.checked = false;
      contentWarningReason.value = '';
      updateContentWarningReasonState();
      clearSelectedImage();
      statusEl.textContent = 'Posted';
      closeOverlay();
      await options.refreshTimeline();
    } catch (error: unknown) {
      console.error('Failed to post:', error);
      statusEl.textContent = 'Failed to post';
      alert('Failed to post. Please try again.');
    } finally {
      isSubmitting = false;
      refreshStatus();
    }
  });
}
