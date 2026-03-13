import type { PubkeyHex } from '../../../types/nostr';

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

  options.output.innerHTML = `
      <section class="nox-welcome py-4 sm:py-8">
        <div class="nox-welcome-hero">
          <div>
            <p class="nox-kicker">Home Feed Access</p>
            <h2 class="nox-welcome-title">Enter nox mode</h2>
            <p class="nox-welcome-copy">
              Sign in with a compatible extension for the cleanest flow, use a local private key if
              you need direct control, or skip straight to the global timeline and watch the network
              in motion.
            </p>
          </div>

          <div class="nox-welcome-grid">
            <div class="nox-feature-card">
              <strong>Direct relay view</strong>
              <span>Posts come from your configured relay set, not from an app server in the middle.</span>
            </div>
            <div class="nox-feature-card">
              <strong>Cache-first rendering</strong>
              <span>IndexedDB keeps feeds, profiles, and timelines close for faster revisits.</span>
            </div>
            <div class="nox-feature-card">
              <strong>Protocol-visible UI</strong>
              <span>Relay management, reply context, NIP-65, and profile identity stay accessible.</span>
            </div>
          </div>
        </div>

        <div class="nox-auth-card space-y-5">
          <div>
            <p class="nox-kicker">Authentication</p>
            <h3 class="nox-panel-title">Choose an entry point</h3>
            <p class="nox-panel-copy">Extension sign-in is recommended. Local key mode stays on this device until logout.</p>
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

          <div class="space-y-2">
            <label for="private-key-input" class="nox-field-label">Private key access</label>
            <div class="flex flex-col sm:flex-row gap-2">
              <input id="private-key-input" type="password" autocomplete="off" placeholder="nsec1... or 64-char hex"
                class="nox-input px-4 py-3 text-sm" />
              <button id="private-key-login"
                class="nox-secondary-button py-3 px-5 whitespace-nowrap">
                Use Private Key
              </button>
            </div>
            <p class="nox-auth-note">Private keys are stored locally so you remain signed in after closing the app. Use an extension when possible for better isolation.</p>
          </div>
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

        localStorage.setItem('nostr_pubkey', pubkeyHex);
        options.clearSessionPrivateKey();
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
        const pubkeyHex: PubkeyHex =
          options.setSessionPrivateKeyFromRaw(rawKey);
        localStorage.setItem('nostr_pubkey', pubkeyHex);
        privateKeyInput.value = '';
        options.updateLogoutButton(options.composeButton);
        window.history.pushState(null, '', '/home');
        options.handleRoute();
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
}
