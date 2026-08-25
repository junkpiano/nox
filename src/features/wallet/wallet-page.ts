/**
 * Wallet tab: connect a Lightning wallet over NIP-47 and see its balance.
 *
 * The custody note is not boilerplate. Someone new to Lightning has no way to
 * tell from the outside whether pasting a string here hands their money to a
 * stranger, and the honest answer - it does not, the wallet stays theirs - is
 * only reassuring if it is actually stated.
 */

import type { SetActiveNavFn } from '../../common/types.js';
import type { NwcConnection, NwcInfo } from './nwc-client.js';
import { getBalance, getInfo, parseNwcUri } from './nwc-client.js';
import {
  clearWalletConnection,
  getWalletAlias,
  getWalletConnection,
  loadWalletConnection,
  saveWalletConnection,
} from './wallet-store.js';

interface WalletPageOptions {
  closeAllWebSockets: () => void;
  stopBackgroundFetch: () => void;
  clearNotification: () => void;
  setActiveNav: SetActiveNavFn;
  output: HTMLElement | null;
  profileSection: HTMLElement | null;
}

const CUSTODY_NOTE: string = `
  <section class="nox-panel p-4 text-sm">
    <h3 class="mb-2 font-semibold">Your wallet stays yours</h3>
    <p class="mb-2">
      nox has no server and no account. Connecting a wallet does not move your
      money anywhere, and the developer of this app never holds, sees, or can
      spend your funds.
    </p>
    <p>
      What you paste below is a permission slip to your own wallet, stored
      encrypted on this device. Your wallet decides what it allows, and you can
      revoke it from the wallet at any time.
    </p>
  </section>
`;

function renderDisconnected(output: HTMLElement): void {
  output.innerHTML = `
    <div class="space-y-4">
      ${CUSTODY_NOTE}

      <section class="nox-panel p-4 space-y-3">
        <div>
          <h3 class="font-semibold">Connect a wallet</h3>
          <p class="mt-1 text-sm">
            In a wallet that supports Nostr Wallet Connect, create a connection
            and paste the string it gives you. Alby, Coinos, Mutiny and others
            support this.
          </p>
        </div>

        <label class="nox-field-label" for="nwc-uri">Connection string</label>
        <textarea
          id="nwc-uri"
          rows="3"
          spellcheck="false"
          placeholder="nostr+walletconnect://..."
          class="nox-input w-full rounded p-2 font-mono text-xs"
        ></textarea>

        <p id="nwc-status" class="text-sm" role="status"></p>

        <button id="nwc-connect" type="button" class="nox-primary-button w-full rounded px-4 py-2 font-semibold">
          Connect
        </button>
      </section>
    </div>
  `;
}

function renderConnected(
  output: HTMLElement,
  connection: NwcConnection,
  alias: string | null,
): void {
  output.innerHTML = `
    <div class="space-y-4">
      <section class="nox-panel p-4">
        <p class="nox-kicker">Balance</p>
        <p id="nwc-balance" class="mt-1 text-3xl font-semibold">—</p>
        <p id="nwc-balance-note" class="mt-1 text-sm"></p>
      </section>

      <section class="nox-panel p-4 space-y-2 text-sm">
        <h3 class="font-semibold">Connected wallet</h3>
        <p id="nwc-alias"></p>
        <p id="nwc-relay" class="break-all font-mono text-xs"></p>
      </section>

      ${CUSTODY_NOTE}

      <section class="nox-panel p-4 space-y-3">
        <p class="text-sm">
          Disconnecting removes the permission from this device. It does not
          touch your wallet or your money.
        </p>
        <button id="nwc-disconnect" type="button" class="nox-muted-button w-full rounded px-4 py-2 font-semibold">
          Disconnect
        </button>
      </section>
    </div>
  `;

  // Assigned as text so a wallet-supplied alias cannot inject markup.
  const aliasEl = output.querySelector('#nwc-alias');
  if (aliasEl) {
    aliasEl.textContent = alias ?? 'Unnamed wallet';
  }
  const relayEl = output.querySelector('#nwc-relay');
  if (relayEl) {
    relayEl.textContent = connection.relay;
  }
}

async function refreshBalance(connection: NwcConnection): Promise<void> {
  const balanceEl = document.getElementById('nwc-balance');
  const noteEl = document.getElementById('nwc-balance-note');
  if (!balanceEl) {
    return;
  }

  balanceEl.textContent = '…';
  try {
    const sats: number = await getBalance(connection);
    balanceEl.textContent = `${sats.toLocaleString()} sats`;
    if (noteEl) {
      noteEl.textContent = '';
    }
  } catch (error: unknown) {
    balanceEl.textContent = '—';
    if (noteEl) {
      // Wallets may withhold get_balance while still allowing payments, so this
      // is reported as information rather than as a broken connection.
      noteEl.textContent =
        error instanceof Error
          ? `Balance unavailable: ${error.message}`
          : 'Balance unavailable.';
    }
  }
}

function wireDisconnect(options: WalletPageOptions): void {
  document
    .getElementById('nwc-disconnect')
    ?.addEventListener('click', (): void => {
      void (async (): Promise<void> => {
        await clearWalletConnection();
        loadWalletPage(options);
      })();
    });
}

function wireConnect(options: WalletPageOptions): void {
  const button = document.getElementById(
    'nwc-connect',
  ) as HTMLButtonElement | null;
  const input = document.getElementById(
    'nwc-uri',
  ) as HTMLTextAreaElement | null;
  const status = document.getElementById('nwc-status');
  if (!button || !input) {
    return;
  }

  button.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      const raw: string = input.value.trim();
      if (!raw) {
        if (status) status.textContent = 'Paste a connection string first.';
        return;
      }

      button.disabled = true;
      button.classList.add('opacity-60', 'cursor-not-allowed');
      if (status) status.textContent = 'Checking the connection…';

      try {
        const connection: NwcConnection = parseNwcUri(raw);
        // Verified before saving, so a typo is caught here rather than at the
        // moment someone tries to pay.
        const info: NwcInfo = await getInfo(connection);
        await saveWalletConnection(connection, info.alias);
        input.value = '';
        loadWalletPage(options);
      } catch (error: unknown) {
        if (status) {
          status.textContent =
            error instanceof Error
              ? error.message
              : 'Could not connect to that wallet.';
        }
        button.disabled = false;
        button.classList.remove('opacity-60', 'cursor-not-allowed');
      }
    })();
  });
}

export function loadWalletPage(options: WalletPageOptions): void {
  options.closeAllWebSockets();
  options.stopBackgroundFetch();
  options.clearNotification();

  options.setActiveNav(
    document.getElementById('nav-home'),
    document.getElementById('nav-global'),
    document.getElementById('nav-relays'),
    document.getElementById('nav-profile'),
    document.getElementById('nav-settings'),
    null,
  );

  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    postsHeader.textContent = 'Wallet';
    postsHeader.style.display = '';
  }

  if (options.profileSection) {
    options.profileSection.innerHTML = '';
    options.profileSection.className = '';
  }

  const output: HTMLElement | null = options.output;
  if (!output) {
    return;
  }

  void (async (): Promise<void> => {
    await loadWalletConnection();
    const connection: NwcConnection | null = getWalletConnection();

    if (!connection) {
      renderDisconnected(output);
      wireConnect(options);
      return;
    }

    renderConnected(output, connection, await getWalletAlias());
    wireDisconnect(options);
    void refreshBalance(connection);
  })();
}
