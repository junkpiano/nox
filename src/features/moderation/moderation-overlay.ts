/**
 * Confirmation and report dialogs for the moderation actions.
 *
 * Event cards dispatch `request-mute-user` and `request-report-content` rather
 * than calling in directly, so the card renderer stays free of relay and
 * signing concerns.
 */

import type { PubkeyHex } from '../../../types/nostr';
import { isMuted } from '../../common/mute-state.js';
import { muteUser, reportContent, unmuteUser } from './moderation-actions.js';
import type { ReportType } from './report.js';
import { REPORT_TYPE_LABELS } from './report.js';

const OVERLAY_ID: string = 'moderation-overlay';

interface ModerationOverlayOptions {
  getRelays: () => string[];
}

function closeOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

function createOverlay(innerHtml: string): HTMLDivElement {
  closeOverlay();

  const overlay: HTMLDivElement = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 h-dvh';
  overlay.innerHTML = `
    <div class="absolute inset-0 bg-black/60" data-overlay-backdrop></div>
    <div class="relative flex h-full items-center justify-center p-4">
      <div class="nox-modal-card w-full max-w-md rounded-lg p-5 shadow-xl">
        ${innerHtml}
      </div>
    </div>
  `;

  overlay
    .querySelector('[data-overlay-backdrop]')
    ?.addEventListener('click', closeOverlay);

  document.body.appendChild(overlay);
  return overlay;
}

function showMuteDialog(
  pubkey: PubkeyHex,
  name: string,
  options: ModerationOverlayOptions,
): void {
  const alreadyMuted: boolean = isMuted(pubkey);
  const safeName: string = name || 'this account';

  const overlay: HTMLDivElement = createOverlay(`
    <h2 class="mb-3 text-lg font-semibold">
      ${alreadyMuted ? 'Unmute' : 'Mute'} account
    </h2>
    <p class="mb-4 text-sm" id="moderation-body"></p>
    <div class="flex gap-2">
      <button id="moderation-cancel" type="button" class="nox-muted-button flex-1 rounded px-4 py-2 font-semibold">
        Cancel
      </button>
      <button id="moderation-confirm" type="button" class="nox-primary-button flex-1 rounded px-4 py-2 font-semibold">
        ${alreadyMuted ? 'Unmute' : 'Mute'}
      </button>
    </div>
  `);

  // Assigned as text so a display name cannot inject markup.
  const body = overlay.querySelector('#moderation-body');
  if (body) {
    body.textContent = alreadyMuted
      ? `Posts from ${safeName} will appear again.`
      : `You will stop seeing posts, replies and notifications from ${safeName}. Your mute list is private.`;
  }

  overlay
    .querySelector('#moderation-cancel')
    ?.addEventListener('click', closeOverlay);

  const confirmButton = overlay.querySelector(
    '#moderation-confirm',
  ) as HTMLButtonElement | null;

  confirmButton?.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      confirmButton.disabled = true;
      confirmButton.classList.add('opacity-60', 'cursor-not-allowed');
      try {
        if (alreadyMuted) {
          await unmuteUser(pubkey, options.getRelays());
        } else {
          await muteUser(pubkey, options.getRelays());
        }
        closeOverlay();
      } catch (error: unknown) {
        console.error('Moderation action failed:', error);
        // The local list already changed, so say what actually happened.
        alert(
          'Saved on this device, but publishing to relays failed. It may not sync to your other clients.',
        );
        closeOverlay();
      }
    })();
  });
}

function showReportDialog(
  pubkey: PubkeyHex,
  eventId: string | undefined,
  options: ModerationOverlayOptions,
): void {
  const optionsHtml: string = REPORT_TYPE_LABELS.map(
    (entry): string => `<option value="${entry.value}">${entry.label}</option>`,
  ).join('');

  const overlay: HTMLDivElement = createOverlay(`
    <h2 class="mb-3 text-lg font-semibold">Report ${eventId ? 'post' : 'account'}</h2>
    <p class="mb-3 text-sm">
      Reports are public and are sent to relay operators.
    </p>
    <label class="nox-field-label mb-1 block text-xs font-semibold uppercase tracking-wide" for="report-type">
      Reason
    </label>
    <select id="report-type" class="nox-input mb-3 w-full rounded p-2 text-sm">
      ${optionsHtml}
    </select>
    <label class="nox-field-label mb-1 block text-xs font-semibold uppercase tracking-wide" for="report-comment">
      Details (optional)
    </label>
    <textarea id="report-comment" rows="3" class="nox-input mb-4 w-full rounded p-2 text-sm"></textarea>
    <div class="flex gap-2">
      <button id="moderation-cancel" type="button" class="nox-muted-button flex-1 rounded px-4 py-2 font-semibold">
        Cancel
      </button>
      <button id="moderation-confirm" type="button" class="nox-primary-button flex-1 rounded px-4 py-2 font-semibold">
        Report
      </button>
    </div>
  `);

  overlay
    .querySelector('#moderation-cancel')
    ?.addEventListener('click', closeOverlay);

  const confirmButton = overlay.querySelector(
    '#moderation-confirm',
  ) as HTMLButtonElement | null;

  confirmButton?.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      const reportType: ReportType = (
        overlay.querySelector('#report-type') as HTMLSelectElement | null
      )?.value as ReportType;
      const comment: string =
        (
          overlay.querySelector('#report-comment') as HTMLTextAreaElement | null
        )?.value.trim() ?? '';

      confirmButton.disabled = true;
      confirmButton.classList.add('opacity-60', 'cursor-not-allowed');
      try {
        await reportContent({
          targetPubkey: pubkey,
          ...(eventId ? { eventId } : {}),
          reportType,
          ...(comment ? { comment } : {}),
          relays: options.getRelays(),
        });
        closeOverlay();
        alert('Report submitted.');
      } catch (error: unknown) {
        console.error('Failed to report content:', error);
        confirmButton.disabled = false;
        confirmButton.classList.remove('opacity-60', 'cursor-not-allowed');
        alert('Failed to submit the report. Please try again.');
      }
    })();
  });
}

/**
 * The menu behind the post's overflow control.
 *
 * A sheet rather than a dropdown: it needs no positioning logic, and on a phone
 * the bottom of the screen is where the thumb already is.
 */
function showPostActions(
  pubkey: PubkeyHex,
  eventId: string,
  name: string,
  options: ModerationOverlayOptions,
): void {
  const muted: boolean = isMuted(pubkey);

  const overlay: HTMLDivElement = createOverlay(`
    <div class="space-y-2">
      <button id="action-mute" type="button" class="nox-muted-button w-full rounded px-4 py-3 text-left font-semibold">
        ${muted ? 'Unmute this account' : 'Mute this account'}
      </button>
      <button id="action-report" type="button" class="nox-muted-button w-full rounded px-4 py-3 text-left font-semibold">
        Report this post
      </button>
      <button id="action-cancel" type="button" class="nox-muted-button w-full rounded px-4 py-3 font-semibold">
        Cancel
      </button>
    </div>
  `);

  overlay
    .querySelector('#action-cancel')
    ?.addEventListener('click', closeOverlay);

  overlay.querySelector('#action-mute')?.addEventListener('click', (): void => {
    showMuteDialog(pubkey, name, options);
  });

  overlay
    .querySelector('#action-report')
    ?.addEventListener('click', (): void => {
      showReportDialog(pubkey, eventId, options);
    });
}

/** Subscribes to the moderation requests dispatched by event cards. */
export function setupModerationOverlay(
  options: ModerationOverlayOptions,
): void {
  window.addEventListener('request-mute-user', ((event: CustomEvent): void => {
    const { pubkey, name } = event.detail;
    showMuteDialog(pubkey as PubkeyHex, name ?? '', options);
  }) as EventListener);

  window.addEventListener('request-post-actions', ((
    event: CustomEvent,
  ): void => {
    const { pubkey, eventId, name } = event.detail;
    showPostActions(pubkey as PubkeyHex, eventId, name ?? '', options);
  }) as EventListener);

  window.addEventListener('request-report-content', ((
    event: CustomEvent,
  ): void => {
    const { pubkey, eventId } = event.detail;
    showReportDialog(pubkey as PubkeyHex, eventId, options);
  }) as EventListener);

  window.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      closeOverlay();
    }
  });
}
