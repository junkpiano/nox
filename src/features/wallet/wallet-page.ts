/**
 * Wallet tab: connect a Lightning wallet over NIP-47 and see its balance.
 *
 * The custody note is not boilerplate. Someone new to Lightning has no way to
 * tell from the outside whether pasting a string here hands their money to a
 * stranger, and the honest answer - it does not, the wallet stays theirs - is
 * only reassuring if it is actually stated.
 */

import type { SetActiveNavFn } from '../../common/types.js';
import type { NwcConnection, NwcInfo, NwcTransaction } from './nwc-client.js';
import {
  getBalance,
  getInfo,
  listTransactions,
  parseNwcUri,
} from './nwc-client.js';
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

/**
 * The explanation, available rather than displayed.
 *
 * An earlier version spent sixty words reassuring the user before they could
 * reach the input. Someone who already understands NWC does not need any of it,
 * and someone who does not is better served by asking than by being lectured on
 * arrival. So it lives behind a question mark, and the screen states the one
 * fact that changes a decision.
 */
const CUSTODY_HELP: string = `
  <h3 class="mb-3 text-lg font-semibold">About wallet connections</h3>
  <p class="mb-2 text-sm">
    nox has no server and no account. Connecting a wallet does not move your
    money, and the developer never holds, sees, or can spend your funds.
  </p>
  <p class="mb-2 text-sm">
    What you paste is a permission to your own wallet, stored encrypted on this
    device. Your wallet decides what it allows, and you can revoke it there at
    any time.
  </p>
  <p class="text-sm">
    Wallets supporting Nostr Wallet Connect include Alby, Coinos and Mutiny.
  </p>
`;

function showWalletHelp(): void {
  document.getElementById('wallet-help-overlay')?.remove();

  const overlay: HTMLDivElement = document.createElement('div');
  overlay.id = 'wallet-help-overlay';
  overlay.className = 'fixed inset-0 z-50 h-dvh';
  overlay.innerHTML = `
    <div class="absolute inset-0 bg-black/60" data-help-backdrop></div>
    <div class="relative flex h-full items-center justify-center p-4">
      <div class="nox-modal-card w-full max-w-md rounded-lg p-5">
        ${CUSTODY_HELP}
        <button id="wallet-help-close" type="button" class="nox-primary-button mt-4 w-full rounded px-4 py-2 font-semibold">
          Close
        </button>
      </div>
    </div>
  `;

  const close = (): void => overlay.remove();
  overlay
    .querySelector('[data-help-backdrop]')
    ?.addEventListener('click', close);
  overlay.querySelector('#wallet-help-close')?.addEventListener('click', close);
  document.body.appendChild(overlay);
}

/** Sits next to the heading, out of the way until wanted. */
const HELP_BUTTON: string = `
  <button id="wallet-help" type="button" class="nox-muted-button rounded-full px-2 py-1 text-xs font-semibold" aria-label="About wallet connections">
    ?
  </button>
`;

function renderDisconnected(output: HTMLElement): void {
  // The placeholder shows the format; no sentence needs to describe it.
  output.innerHTML = `
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <span class="font-semibold">Connect a wallet</span>
        ${HELP_BUTTON}
      </div>

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
    </div>
  `;

  document
    .getElementById('wallet-help')
    ?.addEventListener('click', showWalletHelp);
}

function renderConnected(
  output: HTMLElement,
  connection: NwcConnection,
  alias: string | null,
): void {
  // Connected, the screen has one job: show the balance. The wallet's name and
  // relay are reference, not headline, and Disconnect explains itself.
  output.innerHTML = `
    <div class="space-y-6">
      <div>
        <p id="nwc-balance" class="text-4xl font-semibold">—</p>
        <p id="nwc-balance-note" class="mt-1 text-sm opacity-70"></p>
      </div>

      <div class="text-sm opacity-70">
        <p id="nwc-alias"></p>
        <p id="nwc-relay" class="break-all font-mono text-xs"></p>
      </div>

      <div id="nwc-history" class="text-sm"></div>

      <div class="flex items-center justify-between gap-2 pt-2 text-xs opacity-60">
        <button id="nwc-disconnect" type="button" class="underline">
          Disconnect
        </button>
        ${HELP_BUTTON}
      </div>
    </div>
  `;

  document
    .getElementById('wallet-help')
    ?.addEventListener('click', showWalletHelp);

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

/**
 * Recent payments, when the wallet exposes them.
 *
 * This is what someone opens a wallet to see. Silent when unsupported: a
 * permanent "history unavailable" notice would be a worse use of the space than
 * nothing at all.
 */
async function renderHistory(connection: NwcConnection): Promise<void> {
  const container = document.getElementById('nwc-history');
  if (!container) {
    return;
  }

  let transactions: NwcTransaction[] = [];
  try {
    transactions = await listTransactions(connection);
  } catch {
    return;
  }
  if (transactions.length === 0) {
    return;
  }

  // Without a heading the list is a column of signed numbers and dates, which
  // could be anything. Rendered only once there is something to head.
  const heading: HTMLHeadingElement = document.createElement('h3');
  heading.className =
    'mb-1 text-xs font-semibold uppercase tracking-wide opacity-60';
  heading.textContent = 'Recent payments';

  container.innerHTML = '';
  container.appendChild(heading);

  for (const tx of transactions) {
    const row: HTMLDivElement = document.createElement('div');
    row.className =
      'flex items-baseline justify-between gap-3 border-b border-white/10 py-2 last:border-b-0';

    const left: HTMLDivElement = document.createElement('div');
    left.className = 'min-w-0';

    const amount: HTMLDivElement = document.createElement('div');
    amount.className =
      tx.type === 'incoming'
        ? 'font-semibold text-emerald-400'
        : 'font-semibold';
    amount.textContent = `${tx.type === 'incoming' ? '+' : '−'}${tx.amountSats.toLocaleString()} sats`;

    const memo: HTMLDivElement = document.createElement('div');
    memo.className = 'truncate text-xs opacity-60';
    // Many wallets send no description. Naming the direction is still more
    // than a bare number tells you.
    memo.textContent =
      tx.description || (tx.type === 'incoming' ? 'Received' : 'Sent');

    left.append(amount, memo);

    const when: HTMLSpanElement = document.createElement('span');
    when.className = 'flex-none text-xs opacity-60';
    when.textContent = tx.settledAt
      ? new Date(tx.settledAt * 1000).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'Pending';

    row.append(left, when);
    container.appendChild(row);
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
    document.getElementById('nav-wallet'),
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
    void renderHistory(connection);
  })();
}
