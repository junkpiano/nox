import type { SetActiveNavFn } from '../../common/types.js';

interface AboutPageOptions {
  closeAllWebSockets: () => void;
  stopBackgroundFetch: () => void;
  clearNotification: () => void;
  setActiveNav: SetActiveNavFn;
  output: HTMLElement | null;
  profileSection: HTMLElement | null;
}

export function loadAboutPage(options: AboutPageOptions): void {
  options.closeAllWebSockets();
  options.stopBackgroundFetch();
  options.clearNotification();

  const homeButton: HTMLElement | null = document.getElementById('nav-home');
  const globalButton: HTMLElement | null =
    document.getElementById('nav-global');
  const relaysButton: HTMLElement | null =
    document.getElementById('nav-relays');
  const profileLink: HTMLElement | null =
    document.getElementById('nav-profile');
  const settingsButton: HTMLElement | null =
    document.getElementById('nav-settings');
  const aboutButton: HTMLElement | null = document.getElementById('nav-about');
  options.setActiveNav(
    homeButton,
    globalButton,
    relaysButton,
    profileLink,
    settingsButton,
    null,
  );
  if (aboutButton) {
    aboutButton.classList.remove('text-gray-700');
    aboutButton.classList.add('bg-indigo-100', 'text-indigo-700');
  }

  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    postsHeader.textContent = 'About nox';
    postsHeader.style.display = '';
  }

  if (options.profileSection) {
    options.profileSection.innerHTML = '';
    options.profileSection.className = '';
  }

  if (!options.output) {
    return;
  }

  options.output.innerHTML = `
    <article class="space-y-6 text-sm text-gray-700 leading-relaxed">
      <section class="bg-white border border-gray-200 rounded-lg p-5">
        <h3 class="text-lg font-bold text-gray-900 mb-2">A Practical Relay Client</h3>
        <p>
          nox is built as a fast single-page web client focused on reliability and day-to-day use.
          It keeps the protocol visible, avoids heavy abstractions, and gives you direct control over
          relays, identity, and timelines.
        </p>
      </section>

      <section class="bg-indigo-50 border border-indigo-200 rounded-lg p-5">
        <h3 class="text-base font-bold text-indigo-900 mb-3">What Makes nox Different</h3>
        <ul class="space-y-2 list-disc list-inside">
          <li><span class="font-semibold">Relay-first controls:</span> full relay list management, health checks, and one-click post broadcast to newly added relays.</li>
          <li><span class="font-semibold">Protocol-forward rendering:</span> native support for NIP-30 custom emoji in posts, reactions, and profile metadata.</li>
          <li><span class="font-semibold">Efficient timeline behavior:</span> background sync, timeline caching, and route guards to avoid stale updates during rapid navigation.</li>
          <li><span class="font-semibold">Performance mode:</span> energy-saving mode that replaces heavy inline media with lightweight links.</li>
          <li><span class="font-semibold">No lock-in identity model:</span> works with browser extension signing and local session key flow.</li>
          <li><span class="font-semibold">Readable event views:</span> reply context, referenced-event cards, and OGP preview support in one feed.</li>
        </ul>
      </section>

      <section class="bg-sky-50 border border-sky-200 rounded-lg p-5">
        <h3 class="text-base font-bold text-sky-900 mb-3">Supported NIPs</h3>
        <p class="mb-2 text-xs text-sky-800">
          Based on implemented features in recent git history.
        </p>
        <ul class="space-y-2 list-disc list-inside">
          <li><span class="font-semibold">NIP-05:</span> identifier resolution for profiles (e.g. user@domain.com).</li>
          <li><span class="font-semibold">NIP-07:</span> browser extension signing/auth flow support.</li>
          <li><span class="font-semibold">NIP-30:</span> custom emoji tags in posts, reactions, and profile metadata.</li>
          <li><span class="font-semibold">NIP-36:</span> content warning tags with hide/reveal behavior.</li>
          <li><span class="font-semibold">NIP-65:</span> relay list import/publish for kind 10002 relay metadata.</li>
        </ul>
      </section>

      <section class="bg-gray-50 border border-gray-200 rounded-lg p-5">
	        <h3 class="text-base font-bold text-gray-900 mb-2">Design Goal</h3>
	        <p>
	          nox prioritizes transparency over magic: when something happens on the network, you can
	          usually trace it in the UI. The goal is a client that stays simple enough to trust while
	          still being capable enough for serious daily use.
	        </p>
	      </section>

	      <section class="bg-emerald-50 border border-emerald-200 rounded-lg p-5">
	        <h3 class="text-base font-bold text-emerald-900 mb-2">Donate / Zap</h3>
	        <p>
	          If you find nox useful, you can support development via Lightning Address:
	        </p>
	        <div class="mt-3 flex items-center gap-2 flex-wrap">
	          <code class="px-2 py-1 bg-white border border-emerald-200 rounded font-mono text-emerald-900 text-xs">
	            pay@yusuke.cloud
	          </code>
	          <button id="copy-zap-address" type="button" class="inline-flex items-center justify-center p-1 rounded text-emerald-700 hover:text-emerald-900 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-400/60" aria-label="Copy Lightning Address" title="Copy">
	            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 block" aria-hidden="true">
	              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5h9a2 2 0 012 2v11a2 2 0 01-2 2H9a2 2 0 01-2-2V7a2 2 0 012-2z" />
	              <path stroke-linecap="round" stroke-linejoin="round" d="M7 19H6a2 2 0 01-2-2V6a2 2 0 012-2h11" />
	            </svg>
	          </button>
	          <span id="copy-zap-status" class="text-xs text-emerald-800"></span>
	        </div>
	      </section>
	    </article>
	  `;

  const copyZapButton: HTMLButtonElement | null = options.output.querySelector(
    '#copy-zap-address',
  ) as HTMLButtonElement | null;
  const copyZapStatus: HTMLElement | null =
    options.output.querySelector('#copy-zap-status');
  const zapAddress: string = 'pay@yusuke.cloud';

  if (copyZapButton) {
    copyZapButton.addEventListener('click', async (): Promise<void> => {
      if (copyZapStatus) {
        copyZapStatus.textContent = '';
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(zapAddress);
        } else {
          const temp: HTMLTextAreaElement = document.createElement('textarea');
          temp.value = zapAddress;
          temp.setAttribute('readonly', 'true');
          temp.style.position = 'fixed';
          temp.style.left = '-9999px';
          document.body.appendChild(temp);
          temp.select();
          document.execCommand('copy');
          document.body.removeChild(temp);
        }
        if (copyZapStatus) {
          copyZapStatus.textContent = 'Copied';
          window.setTimeout((): void => {
            if (copyZapStatus) {
              copyZapStatus.textContent = '';
            }
          }, 1500);
        }
      } catch (error) {
        console.error('Failed to copy zap address:', error);
        if (copyZapStatus) {
          copyZapStatus.textContent = 'Copy failed';
        }
      }
    });
  }
}
