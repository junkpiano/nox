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
import { getStoredPubkey } from './profile.js';
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
      <div class="nox-status-field">
        <input
          id="status-text"
          name="status-text"
          type="text"
          maxlength="140"
          placeholder="What are you up to?"
          class="nox-input px-3 py-2"
          value="${current.replace(/"/g, '&quot;')}"
        />
        <button
          type="button"
          id="status-clear"
          class="nox-status-clear"
          aria-label="Clear status"
          title="Clear your status"
        >&times;</button>
      </div>
      <div class="nox-status-expiry">
        <span class="nox-status-expiry-label">Clears after</span>
        ${choices}
      </div>
      <div class="nox-status-actions">
        <button type="submit" class="nox-status-button is-primary">Save</button>
        <button type="button" id="status-cancel" class="nox-status-button">Cancel</button>
      </div>
      <p id="status-message" class="nox-status-message" role="status"></p>
    </form>
  `;
}

/**
 * Turns the status line into its own editor for the person it belongs to.
 *
 * Does nothing at all on someone else's profile. Ownership is read here rather
 * than accepted from the caller: a status can only be signed by the person it
 * belongs to, so a caller that gets this wrong does not produce a status on
 * someone else's profile - it produces one on yours, silently, which is what a
 * hardcoded `true` here did.
 */
export function setupStatusEditor(
  pubkey: PubkeyHex,
  profileSection: HTMLElement,
  options: StatusEditorOptions,
): void {
  const line: HTMLElement | null =
    profileSection.querySelector('#profile-status');
  const panel: HTMLElement | null = profileSection.querySelector(
    '#profile-status-editor',
  );
  const storedPubkey: PubkeyHex | null = getStoredPubkey();
  if (!line || !panel || !storedPubkey || storedPubkey !== pubkey) {
    return;
  }

  // An empty status still needs somewhere to press, or there is no way to set
  // a first one.
  line.classList.remove('hidden');
  line.classList.add('nox-status-editable');

  /**
   * Puts the label and the pencil back, whatever the line currently says.
   *
   * The status arrives from the relays after this runs, and filling it in
   * replaces the line's contents - which would take the pencil with it. Rather
   * than trying to be attached at the right moment, this watches and reapplies:
   * there is no ordering to get wrong that way.
   */
  const decorate = (): void => {
    const existing: HTMLElement | null = line.querySelector('.nox-status-text');
    const text: string = (
      existing ? existing.textContent : line.textContent
    )?.trim();
    const isEmpty: boolean = !text;

    line.dataset.empty = isEmpty ? 'true' : 'false';
    line.setAttribute('role', 'button');
    line.setAttribute('tabindex', '0');
    line.setAttribute(
      'aria-label',
      isEmpty ? 'Set a status' : `Edit your status: ${text}`,
    );
    line.setAttribute('title', 'Set what you are up to');

    if (existing && line.querySelector('.nox-status-pencil')) {
      return;
    }

    // A pencil, because without one this reads as someone's status rather than
    // as a control - which is exactly how it reads on everyone else's profile.
    const label: HTMLSpanElement = document.createElement('span');
    label.className = 'nox-status-text';
    label.textContent = isEmpty ? 'Set a status' : text;

    const pencil: HTMLSpanElement = document.createElement('span');
    pencil.className = 'nox-status-pencil';
    pencil.setAttribute('aria-hidden', 'true');
    pencil.textContent = '✎';

    observer.disconnect();
    // Pencil first: it stays put while the status beside it changes length,
    // so the thing you press is always in the same place.
    line.replaceChildren(pencil, label);
    observer.observe(line, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  };

  const observer: MutationObserver = new MutationObserver(decorate);
  decorate();
  observer.observe(line, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  const open = (): void => {
    const current: string =
      line.dataset.empty === 'true'
        ? ''
        : (line.querySelector('.nox-status-text')?.textContent ?? '').trim();
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

    // Empties the field and stops there. A cross inside an input means "clear
    // this box" everywhere else, and making it reach the network instead would
    // put a destructive, irreversible action behind a small unlabelled icon.
    // Saving an empty status is what clears it, and that is one deliberate tap
    // away.
    const field: HTMLInputElement | null = panel.querySelector('#status-text');
    const clearButton: HTMLElement | null =
      panel.querySelector('#status-clear');

    const syncClearVisibility = (): void => {
      clearButton?.classList.toggle('hidden', !field?.value);
    };
    syncClearVisibility();
    field?.addEventListener('input', syncClearVisibility);

    clearButton?.addEventListener('click', (): void => {
      if (!field) {
        return;
      }
      field.value = '';
      field.focus();
      syncClearVisibility();
      if (message) {
        message.textContent = 'Save to clear your status.';
      }
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
