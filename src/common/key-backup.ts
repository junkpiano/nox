/**
 * One-time prompt telling the user to back up their nsec.
 *
 * Moving the key off plaintext storage and into the platform credential store
 * removes a disclosure risk but creates a loss one: a wiped device, an
 * uninstall, or a cleared credential store takes the key with it, and a lost
 * Nostr key is a lost identity with no recovery path. The prompt exists so that
 * trade-off is never a surprise.
 */

import { getSessionNsec } from './session.js';

const ACKNOWLEDGED_KEY: string = 'nostr_key_backup_acknowledged';
const OVERLAY_ID: string = 'key-backup-overlay';

function hasAcknowledged(): boolean {
  try {
    return localStorage.getItem(ACKNOWLEDGED_KEY) === 'true';
  } catch {
    // A storage failure must not suppress the warning.
    return false;
  }
}

function markAcknowledged(): void {
  try {
    localStorage.setItem(ACKNOWLEDGED_KEY, 'true');
  } catch (error: unknown) {
    console.warn('[key-backup] Failed to persist acknowledgement:', error);
  }
}

function close(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

/**
 * Shows the backup prompt unless the user has already acknowledged it.
 *
 * @param force - Show it again even if previously acknowledged, for a
 *   user-initiated "show my key" action.
 */
export function showKeyBackupNotice(force: boolean = false): void {
  if (!force && hasAcknowledged()) {
    return;
  }

  const nsec: string | null = getSessionNsec();
  if (!nsec) {
    return;
  }

  close();

  const overlay: HTMLDivElement = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 h-dvh';
  overlay.innerHTML = `
    <div class="absolute inset-0 bg-black/60"></div>
    <div class="relative flex h-full items-center justify-center p-4">
      <div class="nox-modal-card w-full max-w-md rounded-lg p-5 shadow-xl">
        <h2 class="mb-3 text-lg font-semibold">Back up your key</h2>
        <p class="mb-3 text-sm">
          Your key is stored encrypted on this device. If you uninstall nox,
          reset the device, or lose it, the key is gone and your account cannot
          be recovered. Save it somewhere safe now.
        </p>
        <label class="nox-field-label mb-1 block text-xs font-semibold uppercase tracking-wide">
          Your private key
        </label>
        <textarea
          id="key-backup-value"
          readonly
          rows="3"
          class="nox-input mb-3 w-full break-all rounded p-2 font-mono text-xs"
        ></textarea>
        <p class="mb-4 text-xs">
          Anyone with this key controls your account. Never share it.
        </p>
        <div class="flex gap-2">
          <button id="key-backup-copy" type="button" class="nox-muted-button flex-1 rounded px-4 py-2 font-semibold">
            Copy
          </button>
          <button id="key-backup-done" type="button" class="nox-primary-button flex-1 rounded px-4 py-2 font-semibold">
            I saved it
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Assigned rather than interpolated so the key never passes through HTML
  // parsing.
  const field = document.getElementById(
    'key-backup-value',
  ) as HTMLTextAreaElement | null;
  if (field) {
    field.value = nsec;
  }

  const copyButton: HTMLElement | null =
    document.getElementById('key-backup-copy');
  copyButton?.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(nsec);
        copyButton.textContent = 'Copied';
      } catch {
        // Clipboard access is refused in some webviews; select instead so the
        // user can copy by hand.
        field?.select();
        copyButton.textContent = 'Select and copy';
      }
    })();
  });

  document
    .getElementById('key-backup-done')
    ?.addEventListener('click', (): void => {
      markAcknowledged();
      close();
    });
}
