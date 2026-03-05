import type { NostrProfile, Npub, PubkeyHex } from '../../../types/nostr';
import { nip19 } from 'nostr-tools';
import { storeProfile } from '../../common/db/index.js';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import { isNip05Identifier, resolveNip05 } from '../../common/nip05.js';
import { getAvatarURL, getDisplayName } from '../../utils/utils.js';
import { recordRelayFailure } from '../relays/relays.js';
import { getCachedProfile, setCachedProfile } from './profile-cache.js';

/**
 * Escapes text for safe HTML rendering.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeHttpUrl(url: string): string | null {
  try {
    const parsed: URL = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeProfileWebsiteUrl(profile: NostrProfile | null): string | null {
  const websiteRaw: unknown = profile?.website ?? profile?.url;
  if (typeof websiteRaw !== 'string') {
    return null;
  }

  const trimmed: string = websiteRaw.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol: string = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return normalizeHttpUrl(withProtocol);
}

function isValidEmojiImageUrl(url: string): boolean {
  try {
    const parsed: URL = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function buildEmojiTagMap(emojiTags: string[][]): Map<string, string> {
  const emojiTagMap: Map<string, string> = new Map();
  emojiTags.forEach((tag: string[]): void => {
    if (tag[0] !== 'emoji') {
      return;
    }
    const shortcode: string | undefined = tag[1];
    const imageUrl: string | undefined = tag[2];
    if (!shortcode || !imageUrl) {
      return;
    }
    if (!/^[a-z0-9_]+$/i.test(shortcode)) {
      return;
    }
    if (!isValidEmojiImageUrl(imageUrl)) {
      return;
    }
    emojiTagMap.set(shortcode.toLowerCase(), imageUrl);
  });
  return emojiTagMap;
}

function emojifySegmentToHtml(
  segment: string,
  emojiTagMap: Map<string, string>,
): string {
  const escaped: string = escapeHtml(segment);
  const withMentionLinks: string = escaped.replace(
    /(nostr:(?:npub1|nprofile1)[0-9a-z]+)/gi,
    (profileRef: string): string => {
      const mentionedProfileId: string = profileRef.replace(/^nostr:/i, '');
      let profilePathNpub: Npub | null = null;
      let label: string = `@${mentionedProfileId.slice(0, 12)}...`;
      try {
        const decoded = nip19.decode(mentionedProfileId);
        let pubkey: PubkeyHex | null = null;
        if (decoded.type === 'npub' && typeof decoded.data === 'string') {
          pubkey = decoded.data as PubkeyHex;
          profilePathNpub = mentionedProfileId as Npub;
        } else if (decoded.type === 'nprofile') {
          const data: any = decoded.data;
          const candidate: string | undefined =
            data?.pubkey || (typeof data === 'string' ? data : undefined);
          if (candidate) {
            pubkey = candidate as PubkeyHex;
            profilePathNpub = nip19.npubEncode(pubkey);
          }
        }
        if (pubkey && profilePathNpub) {
          const cachedProfile: NostrProfile | null = getCachedProfile(pubkey);
          const displayName: string = getDisplayName(
            profilePathNpub,
            cachedProfile,
          );
          label = `@${displayName}`;
        }
      } catch {
        // Ignore invalid mentions and keep the fallback label.
      }
      if (!profilePathNpub) {
        return profileRef;
      }
      const safeNpub: string = escapeHtml(profilePathNpub);
      return `<a href="/${safeNpub}" class="text-indigo-600 underline mention-link" data-mention-npub="${safeNpub}">${escapeHtml(label)}</a>`;
    },
  );

  return withMentionLinks.replace(
    /:([a-z0-9_]+):/gi,
    (match: string, code: string): string => {
      const imageUrl: string | undefined = emojiTagMap.get(code.toLowerCase());
      if (!imageUrl) {
        return match;
      }
      const safeCode: string = escapeHtml(code);
      const safeUrl: string = escapeHtml(imageUrl);
      return `<img src="${safeUrl}" alt=":${safeCode}:" title=":${safeCode}:" class="inline-block align-text-bottom h-5 w-5 mx-0.5" loading="lazy" decoding="async" />`;
    },
  );
}

/**
 * Converts URLs in text to clickable links and emojifies NIP-30 shortcodes.
 */
function emojifyAndLinkify(text: string, emojiTags: string[][]): string {
  const emojiTagMap: Map<string, string> = buildEmojiTagMap(emojiTags);
  const urlRegex: RegExp = /(https?:\/\/[^\s]+)/g;
  let cursor: number = 0;
  let html: string = '';
  let match: RegExpExecArray | null = urlRegex.exec(text);
  while (match) {
    const url: string = match[0];
    const index: number = match.index;
    html += emojifySegmentToHtml(text.slice(cursor, index), emojiTagMap);
    const safeUrl: string = escapeHtml(url);
    html += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:text-blue-700 underline font-medium">${safeUrl}</a>`;
    cursor = index + url.length;
    match = urlRegex.exec(text);
  }
  html += emojifySegmentToHtml(text.slice(cursor), emojiTagMap);
  return html;
}

interface FetchProfileOptions {
  usePersistentCache?: boolean;
  persistProfile?: boolean;
  forceRefresh?: boolean;
}

import { promiseAny, RelayMissError as RelayProfileMissError } from '../../common/promise-utils.js';

const PROFILE_MEM_CACHE_TTL_MS: number = 5 * 60 * 1000;
const PROFILE_RETRY_INTERVAL_MS: number = 30 * 1000;
const profileMemoryCache: Map<
  PubkeyHex,
  { profile: NostrProfile | null; expiresAt: number }
> = new Map();
const profileInFlight: Map<PubkeyHex, Promise<NostrProfile | null>> = new Map();
const profileLastAttempt: Map<PubkeyHex, number> = new Map();

export async function fetchProfile(
  pubkeyHex: PubkeyHex,
  relays: string[],
  options: FetchProfileOptions = {},
): Promise<NostrProfile | null> {
  const usePersistentCache: boolean = options.usePersistentCache !== false;
  const persistProfile: boolean = options.persistProfile !== false;
  const forceRefresh: boolean = options.forceRefresh === true;
  const now: number = Date.now();

  if (!forceRefresh) {
    const cachedMem:
      | { profile: NostrProfile | null; expiresAt: number }
      | undefined = profileMemoryCache.get(pubkeyHex);
    if (cachedMem && cachedMem.expiresAt > now) {
      return cachedMem.profile;
    }

    if (usePersistentCache) {
      const cachedProfile: NostrProfile | null = getCachedProfile(pubkeyHex);
      if (cachedProfile) {
        profileMemoryCache.set(pubkeyHex, {
          profile: cachedProfile,
          expiresAt: now + PROFILE_MEM_CACHE_TTL_MS,
        });
        return cachedProfile;
      }
    }
  }

  if (relays.length === 0) {
    return null;
  }

  const existing: Promise<NostrProfile | null> | undefined =
    profileInFlight.get(pubkeyHex);
  if (existing) {
    return await existing;
  }

  const lastAttempt: number | undefined = profileLastAttempt.get(pubkeyHex);
  if (
    !forceRefresh &&
    lastAttempt &&
    now - lastAttempt < PROFILE_RETRY_INTERVAL_MS
  ) {
    return null;
  }
  profileLastAttempt.set(pubkeyHex, now);

  const request: Promise<NostrProfile | null> =
    (async (): Promise<NostrProfile | null> => {
      const profileRequests: Promise<NostrProfile>[] = relays.map(
        async (relayUrl: string): Promise<NostrProfile> => {
          try {
            const profile: NostrProfile | null =
              await new Promise<NostrProfile | null>((resolve) => {
                let settled: boolean = false;
                const socket: WebSocket = createRelayWebSocket(relayUrl);

                const finish = (value: NostrProfile | null): void => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timeout);
                  socket.close();
                  resolve(value);
                };

                const timeout = setTimeout((): void => {
                  recordRelayFailure(relayUrl);
                  finish(null);
                }, 5000);

                socket.onopen = (): void => {
                  const subId: string = `profile-${Math.random().toString(36).slice(2)}`;
                  const req: [
                    string,
                    string,
                    { kinds: number[]; authors: string[]; limit: number },
                  ] = [
                    'REQ',
                    subId,
                    { kinds: [0], authors: [pubkeyHex], limit: 1 },
                  ];
                  socket.send(JSON.stringify(req));
                };

                socket.onmessage = (msg: MessageEvent): void => {
                  const arr: any[] = JSON.parse(msg.data);
                  if (arr[0] === 'EVENT' && arr[2]?.kind === 0) {
                    try {
                      const parsed: NostrProfile = JSON.parse(arr[2].content);
                      const emojiTags: string[][] = Array.isArray(arr[2].tags)
                        ? arr[2].tags.filter(
                            (tag: unknown): tag is string[] =>
                              Array.isArray(tag) && tag[0] === 'emoji',
                          )
                        : [];
                      parsed.emojiTags = emojiTags;
                      finish(parsed);
                      return;
                    } catch (e) {
                      console.warn('Failed to parse profile JSON', e);
                    }
                  }

                  if (arr[0] === 'EOSE') {
                    finish(null);
                  }
                };

                socket.onerror = (err: Event): void => {
                  console.error(`WebSocket error [${relayUrl}]`, err);
                  finish(null);
                };
              });

            if (!profile) {
              throw new RelayProfileMissError();
            }
            return profile;
          } catch (e) {
            if (!(e instanceof RelayProfileMissError)) {
              console.warn(`Failed to fetch profile from ${relayUrl}`, e);
            }
            throw e;
          }
        },
      );

      try {
        const profile: NostrProfile = await promiseAny(profileRequests);
        if (persistProfile) {
          setCachedProfile(pubkeyHex, profile);
        }
        await storeProfile(pubkeyHex, profile);
        profileMemoryCache.set(pubkeyHex, {
          profile,
          expiresAt: Date.now() + PROFILE_MEM_CACHE_TTL_MS,
        });
        return profile;
      } catch {
        // All relays missed or failed. Do NOT cache null in profileMemoryCache —
        // profileLastAttempt (30s throttle) prevents relay hammering, while
        // avoiding a 5-minute stale null that would block parent/repost card fetches.
      }
      return null;
    })();

  profileInFlight.set(pubkeyHex, request);
  try {
    return await request;
  } finally {
    profileInFlight.delete(pubkeyHex);
  }
}

export function renderProfile(
  pubkey: PubkeyHex,
  npub: Npub,
  profile: NostrProfile | null,
  profileSection: HTMLElement,
): void {
  const avatar: string = getAvatarURL(pubkey, profile);
  const rawName: string = getDisplayName(npub, profile);
  const banner: string | undefined = profile?.banner;
  const emojiTags: string[][] = profile?.emojiTags || [];
  const nip05: string | undefined = profile?.nip05?.trim();
  const hasNip05: boolean = !!nip05 && isNip05Identifier(nip05);
  const websiteUrl: string | null = normalizeProfileWebsiteUrl(profile);
  const websiteLabel: string =
    websiteUrl?.replace(/^https?:\/\//i, '').replace(/\/$/, '') || '';
  const isEnergySavingMode: boolean =
    localStorage.getItem('energy_saving_mode') === 'true';

  const nameHtml: string = emojifyAndLinkify(rawName, emojiTags);
  const bioHtml: string = profile?.about
    ? emojifyAndLinkify(profile.about, emojiTags)
    : '';

  // Avatar HTML based on energy saving mode
  const avatarHtml: string = isEnergySavingMode
    ? `<div class="w-20 h-20 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 text-3xl mb-2 border-4 ${banner ? 'border-white shadow-lg' : 'border-gray-200'}">👤</div>`
    : `<img src="${avatar}" alt="Avatar" class="w-20 h-20 rounded-full object-cover mb-2 border-4 ${banner ? 'border-white shadow-lg' : 'border-gray-200'}"
            onerror="this.src='https://placekitten.com/100/100';" />`;

  // Banner HTML based on energy saving mode
  const bannerHtml: string =
    banner && !isEnergySavingMode
      ? `
        <div class="absolute inset-0 w-full h-full">
          <img src="${banner}" alt="Profile Banner" class="w-full h-full object-cover"
            onerror="this.style.display='none';" />
          <div class="absolute inset-0 bg-gradient-to-b from-black/30 via-black/50 to-black/70"></div>
        </div>
      `
      : '';

  profileSection.innerHTML = `
    <div class="relative overflow-hidden rounded-lg">
      ${bannerHtml}
      <div class="relative flex flex-col items-center ${banner && !isEnergySavingMode ? 'py-12 px-4' : 'py-6'}">
        ${avatarHtml}
        <h2 class="font-bold text-lg ${banner && !isEnergySavingMode ? 'text-white drop-shadow-lg' : 'text-gray-900'} flex items-center gap-1">
          <span>${nameHtml}</span>
          <span id="nip05-verified" class="hidden inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-600 text-white text-[10px]" aria-label="NIP-05 verified" title="NIP-05 verified">✔</span>
        </h2>
        ${bioHtml ? `<p class="${banner && !isEnergySavingMode ? 'text-white/90 drop-shadow' : 'text-gray-600'} text-sm mt-1 text-center max-w-2xl break-words px-4 w-full whitespace-pre-wrap">${bioHtml}</p>` : ''}
        ${websiteUrl ? `<p class="text-sm mt-2 text-center ${banner && !isEnergySavingMode ? 'text-blue-100 drop-shadow' : 'text-blue-600'}"><a href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer" class="underline break-all">${escapeHtml(websiteLabel)}</a></p>` : ''}
        <div id="follow-action" class="mt-4"></div>
      </div>
    </div>
  `;

  if (hasNip05 && nip05) {
    void (async (): Promise<void> => {
      try {
        const resolved: PubkeyHex | null = await resolveNip05(nip05);
        if (resolved !== pubkey) {
          return;
        }
        const icon: HTMLElement | null =
          profileSection.querySelector('#nip05-verified');
        if (icon) {
          icon.classList.remove('hidden');
          icon.setAttribute('title', `NIP-05 verified: ${nip05}`);
        }
      } catch (error: unknown) {
        console.warn('[Profile] Failed to verify NIP-05:', error);
      }
    })();
  }
}
