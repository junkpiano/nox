import { nip19 } from 'nostr-tools';
import type { PubkeyHex } from '../../../types/nostr';
import {
  isTimelineCacheEnabled,
  setTimelineCacheEnabled,
} from '../../common/cache-settings.js';
import {
  clearEvents,
  clearProfiles,
  clearTimelines,
} from '../../common/db/index.js';
import {
  clearEventCache,
  EVENT_CACHE_LIMIT,
  getEventCacheStats,
} from '../../common/event-cache.js';
import { getMutedPubkeys, getMutedWords } from '../../common/mute-state.js';
import type { SetActiveNavFn } from '../../common/types.js';
import { setMutedWords, unmuteUser } from '../moderation/moderation-actions.js';
import {
  clearProfileCache,
  getProfileCacheStats,
  PROFILE_CACHE_LIMIT,
} from '../profile/profile-cache.js';

interface SettingsPageOptions {
  getRelays: () => string[];
  closeAllWebSockets: () => void;
  stopBackgroundFetch: () => void;
  clearNotification: () => void;
  setActiveNav: SetActiveNavFn;
  output: HTMLElement | null;
  profileSection: HTMLElement | null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units: string[] = ['B', 'KB', 'MB', 'GB'];
  let value: number = bytes;
  let unitIndex: number = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded: string = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

export function loadSettingsPage(options: SettingsPageOptions): void {
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
  options.setActiveNav(
    homeButton,
    globalButton,
    relaysButton,
    profileLink,
    settingsButton,
    settingsButton,
  );

  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    postsHeader.textContent = 'Settings';
    postsHeader.style.display = '';
  }

  if (options.profileSection) {
    options.profileSection.innerHTML = '';
    options.profileSection.className = '';
  }

  if (options.output) {
    const isEnergySavingEnabled =
      localStorage.getItem('energy_saving_mode') === 'true';
    const timelineCacheEnabled: boolean = isTimelineCacheEnabled();

    options.output.innerHTML = `
      <div class="space-y-6 text-sm">
        <!-- Energy Saving Mode Section -->
        <div class="bg-white border border-gray-200 rounded-lg p-4">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="font-semibold text-gray-900 mb-1">⚡ Energy Saving Mode</h3>
              <p class="text-xs text-gray-600">Images and videos will show as links instead of loading inline</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" id="energy-saving-toggle" class="sr-only peer" ${isEnergySavingEnabled ? 'checked' : ''}>
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>

        <!-- Muted Accounts Section -->
        <div class="bg-white border border-gray-200 rounded-lg p-4">
          <h3 class="font-semibold text-gray-900 mb-1">Muted accounts</h3>
          <p class="text-xs text-gray-600 mb-3">
            You will not see posts, replies or notifications from these accounts.
            Your mute list is private.
          </p>
          <div id="muted-accounts-list" class="space-y-2"></div>
        </div>

        <!-- Muted Words Section -->
        <div class="bg-white border border-gray-200 rounded-lg p-4">
          <h3 class="font-semibold text-gray-900 mb-1">Muted words</h3>
          <p class="text-xs text-gray-600 mb-3">
            Posts whose text contains one of these words are hidden. Whole words
            only, so muting <span class="font-mono">ass</span> will not hide
            <span class="font-mono">class</span>. Your mute list is private.
          </p>
          <form id="muted-word-form" class="flex gap-2 mb-3">
            <input id="muted-word-input" type="text" maxlength="64"
              placeholder="Add a word"
              class="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2 text-sm">
            <button type="submit"
              class="flex-none rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Add
            </button>
          </form>
          <div id="muted-words-list" class="flex flex-wrap gap-2"></div>
          <p id="muted-words-status" class="mt-2 text-xs text-gray-500"></p>
        </div>

        <!-- Timeline Cache Section -->
        <div class="bg-white border border-gray-200 rounded-lg p-4">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="font-semibold text-gray-900 mb-1">Timeline Cache</h3>
              <p class="text-xs text-gray-600">Store timeline lists on this device for faster loading</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" id="timeline-cache-toggle" class="sr-only peer" ${timelineCacheEnabled ? 'checked' : ''}>
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>

        <!-- Cache Section -->
        <div class="text-gray-600">
          Data stored on this device.
        </div>
        <div class="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
          <div class="text-sm text-gray-800">
            Total stored data: <span id="cache-size">Calculating...</span>
          </div>
          <div class="text-xs text-gray-500 mt-1">
            Posts: <span id="cache-events">-</span> / ${EVENT_CACHE_LIMIT} · Profiles: <span id="cache-profiles">-</span> / ${PROFILE_CACHE_LIMIT}
          </div>
        </div>
        <button id="cache-clear"
          class="bg-red-100 hover:bg-red-200 text-red-700 font-semibold py-2 px-4 rounded-lg transition-colors w-full sm:w-auto">
          Delete Stored Data
        </button>
        <p id="cache-status" class="text-xs text-gray-500"></p>
      </div>
    `;
  }

  renderMutedAccounts(options.getRelays);
  wireMutedWords(options.getRelays);

  const energySavingToggle: HTMLInputElement | null = document.getElementById(
    'energy-saving-toggle',
  ) as HTMLInputElement | null;
  const sizeEl: HTMLElement | null = document.getElementById('cache-size');
  const eventsEl: HTMLElement | null = document.getElementById('cache-events');
  const profilesEl: HTMLElement | null =
    document.getElementById('cache-profiles');
  const statusEl: HTMLElement | null = document.getElementById('cache-status');
  const timelineCacheToggle: HTMLInputElement | null = document.getElementById(
    'timeline-cache-toggle',
  ) as HTMLInputElement | null;
  const clearBtn: HTMLButtonElement | null = document.getElementById(
    'cache-clear',
  ) as HTMLButtonElement | null;

  // Energy saving mode toggle
  if (energySavingToggle) {
    energySavingToggle.addEventListener('change', (): void => {
      const isEnabled = energySavingToggle.checked;
      localStorage.setItem('energy_saving_mode', isEnabled ? 'true' : 'false');

      // Dispatch event to notify the app
      window.dispatchEvent(
        new CustomEvent('energy-saving-changed', {
          detail: { enabled: isEnabled },
        }),
      );

      // Show feedback
      if (statusEl) {
        statusEl.textContent = isEnabled
          ? '⚡ Energy saving mode enabled'
          : 'Energy saving mode disabled';
        setTimeout((): void => {
          if (statusEl) {
            statusEl.textContent = '';
          }
        }, 3000);
      }
    });
  }

  if (timelineCacheToggle) {
    timelineCacheToggle.addEventListener('change', async (): Promise<void> => {
      const isEnabled: boolean = timelineCacheToggle.checked;
      setTimelineCacheEnabled(isEnabled);

      if (!isEnabled) {
        await Promise.all([
          clearTimelines(),
          clearEvents(),
          clearProfiles(),
          clearEventCache(),
        ]);
        clearProfileCache();
      }

      await updateStats();

      if (statusEl) {
        statusEl.textContent = isEnabled
          ? 'Timeline cache enabled.'
          : 'Timeline cache disabled. Cached posts and profiles cleared.';
        setTimeout((): void => {
          if (statusEl) {
            statusEl.textContent = '';
          }
        }, 3000);
      }
    });
  }

  const updateStats = async (): Promise<void> => {
    const [eventStats, profileStats] = await Promise.all([
      getEventCacheStats(),
      getProfileCacheStats(),
    ]);
    const totalBytes: number = eventStats.bytes + profileStats.bytes;
    if (sizeEl) {
      sizeEl.textContent = formatBytes(totalBytes);
    }
    if (eventsEl) {
      eventsEl.textContent = `${eventStats.count}`;
    }
    if (profilesEl) {
      profilesEl.textContent = `${profileStats.count}`;
    }
  };

  updateStats().catch(() => {
    if (sizeEl) {
      sizeEl.textContent = 'Unknown';
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', async (): Promise<void> => {
      if (!window.confirm('Delete stored data?')) {
        return;
      }
      clearBtn.disabled = true;
      clearBtn.classList.add('opacity-60', 'cursor-not-allowed');
      if (statusEl) {
        statusEl.textContent = 'Deleting...';
      }
      await Promise.all([
        clearEventCache(),
        clearProfileCache(),
        clearTimelines(),
        clearEvents(),
        clearProfiles(),
      ]);
      await updateStats();
      if (statusEl) {
        statusEl.textContent = 'Deleted.';
      }
      clearBtn.disabled = false;
      clearBtn.classList.remove('opacity-60', 'cursor-not-allowed');
    });
  }
}

/**
 * Lists muted accounts with an unmute control.
 *
 * Store review expects a blocked account to be reviewable and reversible, not
 * only blockable.
 */
function renderMutedAccounts(getRelays: () => string[]): void {
  const container: HTMLElement | null = document.getElementById(
    'muted-accounts-list',
  );
  if (!container) {
    return;
  }

  const muted: PubkeyHex[] = getMutedPubkeys();
  container.innerHTML = '';

  if (muted.length === 0) {
    const empty: HTMLParagraphElement = document.createElement('p');
    empty.className = 'text-xs text-gray-500';
    empty.textContent = 'No muted accounts.';
    container.appendChild(empty);
    return;
  }

  for (const pubkey of muted) {
    const row: HTMLDivElement = document.createElement('div');
    row.className =
      'flex items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2';

    const link: HTMLAnchorElement = document.createElement('a');
    link.className = 'min-w-0 truncate text-xs font-mono text-blue-600';
    try {
      const npub: string = nip19.npubEncode(pubkey);
      link.href = `/${npub}`;
      link.textContent = `${npub.slice(0, 16)}…${npub.slice(-6)}`;
    } catch {
      link.href = '#';
      link.textContent = pubkey.slice(0, 24);
    }

    const button: HTMLButtonElement = document.createElement('button');
    button.type = 'button';
    button.className =
      'nox-muted-button flex-none rounded px-3 py-1 text-xs font-semibold';
    button.textContent = 'Unmute';
    button.addEventListener('click', (): void => {
      void (async (): Promise<void> => {
        button.disabled = true;
        try {
          await unmuteUser(pubkey, getRelays());
        } catch (error: unknown) {
          console.error('Failed to unmute:', error);
        } finally {
          renderMutedAccounts(getRelays);
        }
      })();
    });

    row.appendChild(link);
    row.appendChild(button);
    container.appendChild(row);
  }
}

/**
 * The muted-word editor.
 *
 * Every change publishes the whole list, because kind:10000 is replaceable:
 * a write that carried only the words would delete the muted accounts, and one
 * that carried only the accounts would delete the words.
 */
function wireMutedWords(getRelays: () => string[]): void {
  const form: HTMLFormElement | null = document.getElementById(
    'muted-word-form',
  ) as HTMLFormElement | null;
  const input: HTMLInputElement | null = document.getElementById(
    'muted-word-input',
  ) as HTMLInputElement | null;
  const list: HTMLElement | null = document.getElementById('muted-words-list');
  const status: HTMLElement | null =
    document.getElementById('muted-words-status');
  if (!form || !input || !list) {
    return;
  }

  const commit = async (words: string[]): Promise<void> => {
    if (status) {
      status.textContent = 'Saving…';
    }
    try {
      await setMutedWords(words, getRelays());
      if (status) {
        status.textContent = '';
      }
    } catch (error: unknown) {
      console.error('Failed to save muted words:', error);
      if (status) {
        // The word is muted locally either way; say so rather than implying
        // nothing happened.
        status.textContent =
          'Muted on this device, but the list could not be published.';
      }
    }
    render();
  };

  function render(): void {
    if (!list) {
      return;
    }
    const words: string[] = getMutedWords();
    list.innerHTML = '';

    if (words.length === 0) {
      const empty: HTMLParagraphElement = document.createElement('p');
      empty.className = 'text-xs text-gray-500';
      empty.textContent = 'No muted words.';
      list.appendChild(empty);
      return;
    }

    for (const word of words) {
      const chip: HTMLSpanElement = document.createElement('span');
      chip.className =
        'inline-flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs';

      const label: HTMLSpanElement = document.createElement('span');
      // textContent, not innerHTML: this string came from a text field and is
      // published to relays, so it comes back from them too.
      label.textContent = word;

      const remove: HTMLButtonElement = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-gray-500 hover:text-red-600';
      remove.setAttribute('aria-label', `Unmute ${word}`);
      remove.textContent = '×';
      remove.addEventListener('click', (): void => {
        void commit(getMutedWords().filter((w: string): boolean => w !== word));
      });

      chip.appendChild(label);
      chip.appendChild(remove);
      list.appendChild(chip);
    }
  }

  form.addEventListener('submit', (event: SubmitEvent): void => {
    event.preventDefault();
    const word: string = input.value.trim();
    if (!word) {
      return;
    }
    input.value = '';
    void commit([...getMutedWords(), word]);
  });

  render();
}
