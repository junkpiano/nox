/**
 * Editing your own status, in the place it is read.
 *
 * A status is one line about right now, so the editor is the line itself:
 * tapping what is displayed turns it into a field. There is no screen to find,
 * because a screen you have to go looking for is not where anyone would write
 * "back in five minutes".
 *
 * Only the owner sees any of this. Everyone else's profile shows the status
 * that `user-status.ts` reads, and nothing more.
 */

import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { signUserStatusEvent } from './user-status.js';

interface StatusEditorOptions {
  publishEvent: (event: NostrEvent, relays: string[]) => Promise<unknown>;
  getRelays: () => string[];
  onPublished: () => void;
}

/**
 * How long a status is worth believing.
 *
 * An hour covers the thing you are doing; a day covers the day. "Until I say
 * otherwise" is offered but is not the default, because the common case is
 * something that stops being true and nobody comes back to clear it.
 */
const EXPIRY_CHOICES: ReadonlyArray<{
  label: string;
  seconds: number | null;
}> = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86_400 },
  { label: 'No limit', seconds: null },
];

function editorMarkup(current: string): string {
  const choices: string = EXPIRY_CHOICES.map(
    (choice, index): string => `
      <label class="inline-flex items-center gap-1.5">
        <input type="radio" name="status-expiry" value="${index}" ${index === 0 ? 'checked' : ''} />
        <span>${choice.label}</span>
      </label>`,
  ).join('');

  return `
    <form id="status-form" class="nox-status-editor">
      <input
        id="status-text"
        name="status-text"
        type="text"
        maxlength="140"
        placeholder="What are you up to?"
        class="nox-input px-3 py-2"
        value="${current.replace(/"/g, '&quot;')}"
      />
      <div class="nox-status-expiry">
        <span class="nox-status-expiry-label">Clears after</span>
        ${choices}
      </div>
      <div class="nox-status-actions">
        <button type="submit" class="nox-primary-button px-4 py-2">Save</button>
        <button type="button" id="status-clear" class="nox-secondary-button px-4 py-2">Clear</button>
        <button type="button" id="status-cancel" class="nox-muted-button px-4 py-2">Cancel</button>
      </div>
      <p id="status-message" class="nox-status-message" role="status"></p>
    </form>
  `;
}

/**
 * Turns the status line into its own editor for the person it belongs to.
 *
 * Does nothing at all on someone else's profile - the caller decides whose
 * this is, and passes `isOwner`.
 */
export function setupStatusEditor(
  pubkey: PubkeyHex,
  profileSection: HTMLElement,
  isOwner: boolean,
  options: StatusEditorOptions,
): void {
  const line: HTMLElement | null =
    profileSection.querySelector('#profile-status');
  const panel: HTMLElement | null = profileSection.querySelector(
    '#profile-status-editor',
  );
  if (!line || !panel || !isOwner) {
    return;
  }

  // An empty status still needs somewhere to press, or there is no way to set
  // a first one.
  line.classList.remove('hidden');
  line.classList.add('nox-status-editable');
  if (!line.textContent?.trim()) {
    line.textContent = 'Set a status';
    line.dataset.empty = 'true';
  }
  line.setAttribute('role', 'button');
  line.setAttribute('tabindex', '0');
  line.setAttribute('title', 'Set what you are up to');

  const open = (): void => {
    const current: string =
      line.dataset.empty === 'true' ? '' : (line.textContent ?? '').trim();
    panel.innerHTML = editorMarkup(current);
    panel.classList.remove('hidden');
    line.classList.add('hidden');
    (panel.querySelector('#status-text') as HTMLInputElement | null)?.focus();

    const close = (): void => {
      panel.innerHTML = '';
      panel.classList.add('hidden');
      line.classList.remove('hidden');
    };

    panel
      .querySelector('#status-cancel')
      ?.addEventListener('click', (): void => close());

    const message: HTMLElement | null = panel.querySelector('#status-message');

    const publish = async (
      text: string,
      seconds: number | null,
    ): Promise<void> => {
      if (message) {
        message.textContent = 'Publishing…';
      }
      try {
        const event: NostrEvent = await signUserStatusEvent({
          pubkeyHex: pubkey,
          text,
          expiresInSeconds: seconds,
        });
        await options.publishEvent(event, options.getRelays());
        close();
        options.onPublished();
      } catch (error: unknown) {
        console.error('[status] Failed to publish:', error);
        if (message) {
          // Says which half failed. The status was not published, so the line
          // on screen is still the truth.
          message.textContent = 'Could not publish. Your status is unchanged.';
        }
      }
    };

    panel
      .querySelector('#status-form')
      ?.addEventListener('submit', (event: Event): void => {
        event.preventDefault();
        const text: string =
          (panel.querySelector('#status-text') as HTMLInputElement | null)
            ?.value ?? '';
        const index: number = Number(
          (
            panel.querySelector(
              'input[name="status-expiry"]:checked',
            ) as HTMLInputElement | null
          )?.value ?? '0',
        );
        void publish(text, EXPIRY_CHOICES[index]?.seconds ?? null);
      });

    panel
      .querySelector('#status-clear')
      ?.addEventListener('click', (): void => {
        // Clearing is publishing an empty status: NIP-38 has no delete, and
        // every reader already treats empty as nothing to show.
        void publish('', null);
      });
  };

  line.addEventListener('click', open);
  line.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}
