import type { PubkeyHex } from '../../../types/nostr';
import { showKeyBackupNotice } from '../../common/key-backup.js';
import { isNativeRuntime } from '../../common/native-http.js';
import {
  beginSignedInSession,
  InvalidPublicKeyError,
  startReadOnlySession,
} from '../../common/session.js';

interface ShowInputFormOptions {
  output: HTMLElement | null;
  profileSection: HTMLElement | null;
  composeButton: HTMLElement | null;
  updateLogoutButton: (composeButton: HTMLElement | null) => void;
  clearSessionPrivateKey: () => void;
  setSessionPrivateKeyFromRaw: (rawKey: string) => PubkeyHex;
  handleRoute: () => void;
}

interface WindowWithNostr extends Window {
  nostr?: {
    getPublicKey: () => Promise<string>;
  };
}

export async function showInputForm(
  options: ShowInputFormOptions,
): Promise<void> {
  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    postsHeader.style.display = 'none';
  }

  if (options.profileSection) {
    options.profileSection.innerHTML = '';
    options.profileSection.className = '';
  }

  if (!options.output) {
    return;
  }

  // The same page is drawn in a browser and in the desktop app, and the key
  // lands somewhere different in each: localStorage on the web, the OS
  // credential store under Tauri. The note says which.
  const storageNote: string = isNativeRuntime()
    ? "Stored in this device's credential store. Signing out deletes it."
    : 'Stored in this browser only, which is less secure than an extension. Signing out deletes it.';

  options.output.innerHTML = `
      <section class="nox-welcome py-4 sm:py-8">
        <div class="nox-auth-card space-y-5">
          <div>
            <p class="nox-kicker">Welcome</p>
            <h3 class="nox-panel-title">Sign in to nox</h3>
            <p class="nox-panel-copy">No account is needed. Your key is your identity.</p>
            <p class="nox-panel-copy mt-2">A browser extension is the recommended way in. Your secret key stays in the extension.</p>
          </div>

          <div class="nox-auth-actions">
            <button id="welcome-login" class="nox-primary-button py-3 px-6">
              <span aria-hidden="true">🔑</span>
              <span>Connect Extension</span>
            </button>
            <button id="welcome-global" class="nox-secondary-button py-3 px-6">
              <span aria-hidden="true">🌍</span>
              <span>View Global Timeline</span>
            </button>
          </div>

          <div class="nox-browse space-y-2">
            <p class="nox-kicker">Just looking?</p>
            <label for="public-key-input" class="sr-only">Public key to browse as</label>
            <div class="flex flex-col sm:flex-row gap-2">
              <input id="public-key-input" type="text" autocomplete="off" spellcheck="false" placeholder="npub1… or 64-character hex"
                class="nox-input px-4 py-3 text-sm" />
              <button id="public-key-browse" class="nox-secondary-button py-3 px-5 whitespace-nowrap">
                Browse
              </button>
            </div>
            <p id="public-key-error" class="nox-auth-error" hidden></p>
            <p class="nox-auth-note">A public key is safe to share. Browsing shows what that key sees; nothing can be posted.</p>
          </div>

          <details class="nox-reveal">
            <summary class="nox-reveal-summary">I have a secret key</summary>
            <div class="nox-reveal-body space-y-2">
              <p class="nox-auth-note">Anyone with this key can post as you.</p>
              <label for="private-key-input" class="sr-only">Secret key</label>
              <div class="flex flex-col sm:flex-row gap-2">
                <input id="private-key-input" type="password" autocomplete="off" placeholder="nsec1… or 64-character hex"
                  class="nox-input px-4 py-3 text-sm" />
                <button id="private-key-login"
                  class="nox-secondary-button py-3 px-5 whitespace-nowrap">
                  Use this key
                </button>
              </div>
              <p class="nox-auth-note">${storageNote}</p>
            </div>
          </details>
        </div>
      </section>
    `;

  const welcomeLoginBtn: HTMLElement | null =
    document.getElementById('welcome-login');
  const welcomeGlobalBtn: HTMLElement | null =
    document.getElementById('welcome-global');
  const privateKeyLoginBtn: HTMLElement | null =
    document.getElementById('private-key-login');
  const privateKeyInput: HTMLInputElement | null = document.getElementById(
    'private-key-input',
  ) as HTMLInputElement;
  const publicKeyInput: HTMLInputElement | null = document.getElementById(
    'public-key-input',
  ) as HTMLInputElement;
  const publicKeyBrowseBtn: HTMLElement | null =
    document.getElementById('public-key-browse');
  const publicKeyError: HTMLElement | null =
    document.getElementById('public-key-error');

  if (welcomeLoginBtn) {
    welcomeLoginBtn.addEventListener('click', async (): Promise<void> => {
      try {
        const nostrWindow: WindowWithNostr = window as WindowWithNostr;
        if (!nostrWindow.nostr) {
          alert(
            'No compatible extension found!\n\nPlease install a browser extension that exposes the nostr signing API, such as:\n- Alby (getalby.com)\n- nos2x\n- Flamingo\n\nThen reload this page.',
          );
          return;
        }

        const pubkeyHex: string = await nostrWindow.nostr.getPublicKey();
        if (!pubkeyHex) {
          alert('Failed to get public key from extension.');
          return;
        }

        options.clearSessionPrivateKey();
        beginSignedInSession(pubkeyHex as PubkeyHex);
        options.updateLogoutButton(options.composeButton);
        window.history.pushState(null, '', '/home');
        options.handleRoute();
      } catch (error: unknown) {
        console.error('Extension login error:', error);
        if (error instanceof Error) {
          alert(`Failed to connect with extension: ${error.message}`);
        } else {
          alert(
            'Failed to connect with extension. Please make sure your extension is unlocked and try again.',
          );
        }
      }
    });
  }

  if (welcomeGlobalBtn) {
    welcomeGlobalBtn.addEventListener('click', (): void => {
      window.history.pushState(null, '', '/global');
      options.handleRoute();
    });
  }

  if (privateKeyLoginBtn) {
    privateKeyLoginBtn.addEventListener('click', (): void => {
      try {
        if (!privateKeyInput) return;
        const rawKey: string = privateKeyInput.value.trim();
        if (!rawKey) {
          alert('Please enter your private key.');
          return;
        }
        // Loading the key records the sign-in itself.
        options.setSessionPrivateKeyFromRaw(rawKey);
        privateKeyInput.value = '';
        options.updateLogoutButton(options.composeButton);
        window.history.pushState(null, '', '/home');
        options.handleRoute();
        // The key now lives in encrypted device storage, which the user cannot
        // read back. Warn before that becomes their only copy.
        showKeyBackupNotice();
      } catch (error: unknown) {
        console.error('Private key login error:', error);
        options.clearSessionPrivateKey();
        if (error instanceof Error) {
          alert(`Failed to use private key: ${error.message}`);
        } else {
          alert('Failed to use private key.');
        }
      }
    });
  }

  if (privateKeyInput) {
    privateKeyInput.addEventListener('keypress', (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && privateKeyLoginBtn) {
        privateKeyLoginBtn.click();
      }
    });
  }

  // Browsing as a public key: a way to see what the app is before trusting
  // it with a secret. The mistake it guards against is told inline, under
  // the box, rather than in an alert - it is a typo, not an event.
  const showPublicKeyError = (message: string | null): void => {
    if (!publicKeyError) return;
    publicKeyError.textContent = message ?? '';
    publicKeyError.hidden = message === null;
  };

  if (publicKeyBrowseBtn) {
    publicKeyBrowseBtn.addEventListener('click', (): void => {
      if (!publicKeyInput) return;
      try {
        startReadOnlySession(publicKeyInput.value);
        showPublicKeyError(null);
        publicKeyInput.value = '';
        options.updateLogoutButton(options.composeButton);
        window.history.pushState(null, '', '/home');
        options.handleRoute();
      } catch (error: unknown) {
        showPublicKeyError(
          error instanceof InvalidPublicKeyError
            ? error.message
            : 'Could not start browsing with that key.',
        );
      }
    });
  }

  if (publicKeyInput) {
    publicKeyInput.addEventListener('keypress', (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && publicKeyBrowseBtn) {
        publicKeyBrowseBtn.click();
      }
    });
    publicKeyInput.addEventListener('input', (): void =>
      showPublicKeyError(null),
    );
  }
}
