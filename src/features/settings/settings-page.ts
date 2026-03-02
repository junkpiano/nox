import {
  clearEventCache,
  getEventCacheStats,
} from '../../common/event-cache.js';
import {
  isTimelineCacheEnabled,
  setTimelineCacheEnabled,
} from '../../common/cache-settings.js';
import {
  clearEvents,
  clearProfiles,
  clearTimelines,
} from '../../common/db/index.js';
import type { SetActiveNavFn } from '../../common/types.js';
import {
  clearProfileCache,
  getProfileCacheStats,
} from '../profile/profile-cache.js';

interface SettingsPageOptions {
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
            Posts: <span id="cache-events">-</span> / Profiles: <span id="cache-profiles">-</span>
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

  const energySavingToggle: HTMLInputElement | null = document.getElementById(
    'energy-saving-toggle',
  ) as HTMLInputElement | null;
  const sizeEl: HTMLElement | null = document.getElementById('cache-size');
  const eventsEl: HTMLElement | null = document.getElementById('cache-events');
  const profilesEl: HTMLElement | null =
    document.getElementById('cache-profiles');
  const statusEl: HTMLElement | null = document.getElementById('cache-status');
  const timelineCacheToggle: HTMLInputElement | null =
    document.getElementById('timeline-cache-toggle') as HTMLInputElement | null;
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
