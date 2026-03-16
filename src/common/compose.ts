import { finalizeEvent } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { storeEvent } from './db/index.js';
import type { ImageUploadResult } from './image-upload.js';
import { uploadImage } from './image-upload.js';

interface ComposeOverlayOptions {
  composeButton: HTMLElement | null;
  getSessionPrivateKey: () => Uint8Array | null;
  getRelays: () => string[];
  publishEvent: (event: NostrEvent, relays: string[]) => Promise<void>;
  refreshTimeline: () => Promise<void>;
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

  const updateContentWarningReasonState = (): void => {
    const enabled: boolean = contentWarningToggle.checked;
    contentWarningReason.disabled = !enabled;
    if (!enabled) {
      contentWarningReason.value = '';
      contentWarningReason.classList.add('opacity-60', 'cursor-not-allowed');
    } else {
      contentWarningReason.classList.remove(
        'opacity-60',
        'cursor-not-allowed',
      );
    }
  };

  const openOverlay = (): void => {
    overlay.style.display = '';
    updateContentWarningReasonState();
    document.body.classList.add('overflow-hidden');
    textarea.focus();
  };

  const clearSelectedImage = (): void => {
    selectedImageFile = null;
    if (imageInput) {
      imageInput.value = '';
    }
    if (imagePreview) {
      imagePreview.style.display = 'none';
    }
    if (imagePreviewImg) {
      imagePreviewImg.src = '';
    }
  };

  const closeOverlay = (): void => {
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
      selectedImageFile = file;
      const objectUrl: string = URL.createObjectURL(file);
      imagePreviewImg.src = objectUrl;
      imagePreview.style.display = '';
    });
  }

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
    if (!textarea.value.trim() && !selectedImageFile) {
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

    try {
      const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
      if (!storedPubkey) {
        throw new Error('Not logged in');
      }

      let imageUrl: string | null = null;
      if (selectedImageFile) {
        statusEl.textContent = 'Uploading image...';
        const result: ImageUploadResult = await uploadImage(
          selectedImageFile,
          storedPubkey as PubkeyHex,
          options.getSessionPrivateKey,
        );
        imageUrl = result.url;
      }

      statusEl.textContent = 'Posting...';

      const tags: string[][] = [];
      if (contentWarningToggle.checked) {
        const reason: string = contentWarningReason.value.trim();
        if (reason) {
          tags.push(['content-warning', reason]);
          tags.push(['l', reason, 'content-warning']);
        } else {
          tags.push(['content-warning']);
        }
        tags.push(['L', 'content-warning']);
      }

      const textContent: string = textarea.value.trim();
      const content: string =
        imageUrl !== null
          ? textContent
            ? `${textContent}\n\n${imageUrl}`
            : imageUrl
          : textContent;

      const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
        kind: 1,
        pubkey: storedPubkey as PubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
      };

      let signedEvent: NostrEvent;
      if (hasExtension) {
        signedEvent = await (window as any).nostr.signEvent(unsignedEvent);
      } else {
        if (!privateKey) {
          throw new Error('No signing method available');
        }
        signedEvent = finalizeEvent(unsignedEvent, privateKey) as NostrEvent;
      }

      await options.publishEvent(signedEvent, options.getRelays());
      await storeEvent(signedEvent, { isHomeTimeline: false });
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
