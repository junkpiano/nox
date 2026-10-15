import { nip19 } from 'nostr-tools';
import type {
  NostrEvent,
  NostrProfile,
  Npub,
  PubkeyHex,
} from '../../../types/nostr';
import {
  avatarErrorAttribute,
  fallbackAvatarUrl,
} from '../../common/avatar.js';
import { loadableOnThisPage } from '../../common/avatar-dom.js';
import {
  type ContentHtmlOptions,
  renderContentHtml,
} from '../../common/content-html.js';
import { getProfile } from '../../common/db/index.js';
import { escapeHtml } from '../../common/escape-html.js';
import { isNip05Identifier, resolveNip05 } from '../../common/nip05.js';
import { fetchFollowSet } from '../../common/notification-filter.js';
import {
  cacheResolvedProfile,
  fetchProfile,
  fetchProfiles,
  getAuthoritativeProfile,
} from '../../common/profile-fetch.js';
import { signWithSession } from '../../common/signer.js';
import { openZapComposer } from '../../common/zap.js';
import { getAvatarURL, getDisplayName } from '../../utils/utils.js';
import { getRelays } from '../relays/relays.js';
import { fetchUserStatus } from './user-status.js';

// Moved to the shared core; re-exported for this module's importers.
export { fetchProfile, fetchProfiles, getAuthoritativeProfile };

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

function normalizeProfileWebsiteUrl(
  profile: NostrProfile | null,
): string | null {
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

import { getSessionPrivateKey } from '../../common/session.js';

const PROFILE_EDITABLE_FIELDS: Array<
  | 'display_name'
  | 'name'
  | 'about'
  | 'picture'
  | 'banner'
  | 'website'
  | 'nip05'
  | 'lud16'
> = [
  'display_name',
  'name',
  'about',
  'picture',
  'banner',
  'website',
  'nip05',
  'lud16',
];

interface ProfileEditorOptions {
  getRelays: () => string[];
  publishEvent: (event: NostrEvent, relayList: string[]) => Promise<void>;
  onProfileUpdated?: (profile: NostrProfile) => void;
}

interface WindowWithNostr extends Window {
  nostr?: {
    signEvent: (event: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
  };
}

export function getStoredPubkey(): PubkeyHex | null {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  return storedPubkey ? (storedPubkey as PubkeyHex) : null;
}

function canSignProfileMetadata(): boolean {
  const nostr: WindowWithNostr['nostr'] = (window as WindowWithNostr).nostr;
  if (nostr?.signEvent) {
    return true;
  }
  return Boolean(getSessionPrivateKey());
}

function stripTransientProfileFields(profile: NostrProfile): NostrProfile {
  const sanitized: NostrProfile = { ...profile };
  delete sanitized.emojiTags;
  return sanitized;
}

function buildEditableProfileDraft(
  currentProfile: NostrProfile | null,
  form: HTMLFormElement,
): NostrProfile {
  const formData: FormData = new FormData(form);
  const draft: NostrProfile = stripTransientProfileFields(currentProfile || {});

  PROFILE_EDITABLE_FIELDS.forEach((field): void => {
    const rawValue: FormDataEntryValue | null = formData.get(field);
    const value: string = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (value) {
      draft[field] = value;
    } else {
      delete draft[field];
    }
  });

  if (draft.website) {
    draft.url = draft.website;
  } else {
    delete draft.url;
  }

  return draft;
}

async function signProfileMetadataEvent(
  pubkeyHex: PubkeyHex,
  profile: NostrProfile,
): Promise<NostrEvent> {
  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
    kind: 0,
    pubkey: pubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: Array.isArray(profile.emojiTags) ? profile.emojiTags : [],
    content: JSON.stringify(stripTransientProfileFields(profile)),
  };

  return signWithSession(unsignedEvent);
}

/** A mentioned person's name, when it is already in memory. */
function knownName(pubkey: PubkeyHex): string | null {
  const profile: NostrProfile | null | undefined = getAuthoritativeProfile(
    pubkey,
    null,
  );
  return profile
    ? `@${getDisplayName(nip19.npubEncode(pubkey), profile)}`
    : null;
}

/**
 * Mentioned names in a bio, from the store once it answers.
 *
 * The bio is drawn at once with whatever names are in memory; the store is
 * asked afterwards for the rest, and each link is relabelled as its name
 * arrives. Nothing is fetched from relays for this: a bio is not a feed.
 */
function fillMentionNames(container: HTMLElement): void {
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>(
    'a.mention-link[data-pubkey]',
  )) {
    const pubkey: PubkeyHex = (anchor.dataset.pubkey ?? '') as PubkeyHex;
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) continue;
    void getProfile(pubkey).then((stored: NostrProfile | null): void => {
      if (stored) {
        anchor.textContent = `@${getDisplayName(nip19.npubEncode(pubkey), stored)}`;
      }
    });
  }
}

export function renderProfile(
  pubkey: PubkeyHex,
  npub: Npub,
  profile: NostrProfile | null,
  profileSection: HTMLElement,
): void {
  const renderProfileData: NostrProfile | null = getAuthoritativeProfile(
    pubkey,
    profile,
  );
  const avatarRaw: string = getAvatarURL(pubkey, renderProfileData);
  // Validate scheme (reject javascript:/data: etc.) and escape for the src="" attribute
  // context. A profile's picture/banner are attacker-controlled kind-0 fields.
  const avatar: string =
    loadableOnThisPage(avatarRaw) ?? fallbackAvatarUrl(pubkey);
  const rawName: string = profileName(npub, renderProfileData);
  const banner: string | null = renderProfileData?.banner
    ? normalizeHttpUrl(renderProfileData.banner)
    : null;
  const emojiTags: string[][] = renderProfileData?.emojiTags || [];
  const nip05: string | undefined = renderProfileData?.nip05?.trim();
  const hasNip05: boolean = !!nip05 && isNip05Identifier(nip05);
  const websiteUrl: string | null =
    normalizeProfileWebsiteUrl(renderProfileData);
  const websiteLabel: string =
    websiteUrl?.replace(/^https?:\/\//i, '').replace(/\/$/, '') || '';
  const isEnergySavingMode: boolean =
    localStorage.getItem('energy_saving_mode') === 'true';

  // A line of prose, not a post: links stay links and a quote stays text.
  // Names already in memory are used at once; the store fills in the rest.
  const asLine: ContentHtmlOptions = { inline: true, mentionLabel: knownName };
  const nameHtml: string = renderContentHtml(rawName, emojiTags, asLine).html;
  const bioHtml: string = renderProfileData?.about
    ? renderContentHtml(renderProfileData.about, emojiTags, asLine).html
    : '';

  // The banner is a banner: a fixed strip the person chose, with nothing
  // written over it. The face straddles its lower edge, and everything that
  // has to be read sits on the plain ground below.
  const avatarHtml: string = isEnergySavingMode
    ? `<div class="nox-profile-avatar nox-profile-avatar-blank" aria-hidden="true">👤</div>`
    : `<img src="${escapeHtml(avatar)}" alt="" class="nox-profile-avatar"
            onerror="${avatarErrorAttribute(pubkey)}" />`;

  const bannerHtml: string =
    banner && !isEnergySavingMode
      ? `<div class="nox-profile-banner"><img src="${escapeHtml(banner)}" alt="" onerror="this.parentElement.classList.add('nox-profile-banner-blank'); this.remove();" /></div>`
      : `<div class="nox-profile-banner nox-profile-banner-blank"></div>`;

  // The line under the name: where they can be reached, and how many they
  // follow. The count is filled in once the relays answer.
  const identityParts: string[] = [];
  identityParts.push(
    nip05
      ? `<span class="nox-profile-nip05">${escapeHtml(nip05)}<span id="nip05-verified" class="nox-profile-verified hidden" aria-label="NIP-05 verified" title="NIP-05 verified">✔</span></span>`
      : `<span class="nox-profile-npub" title="${escapeHtml(npub)}">${escapeHtml(npub.slice(0, 12))}…</span>`,
  );
  if (websiteUrl) {
    identityParts.push(
      `<a href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer" class="nox-profile-website">${escapeHtml(websiteLabel)}</a>`,
    );
  }
  identityParts.push(
    `<span id="profile-following" class="nox-profile-following" hidden></span>`,
  );

  // Whose header this is. The follow count below arrives after a relay
  // round trip, by which time this section may be showing somebody else.
  profileSection.dataset.pubkey = pubkey;
  profileSection.innerHTML = `
    <div class="nox-profile">
      ${bannerHtml}
      <div class="nox-profile-body">
        <div class="nox-profile-face">${avatarHtml}</div>
        <h2 class="nox-profile-name">${nameHtml}</h2>
        <p class="nox-profile-identity">${identityParts.join('<span class="nox-profile-dot" aria-hidden="true">·</span>')}</p>
        <p id="profile-status" class="nox-profile-status hidden"></p>
        <div id="profile-status-editor" class="hidden mt-2 w-full max-w-md"></div>
        ${
          bioHtml
            ? `<div class="nox-profile-bio" data-folded="true">
                 <p class="nox-post-text nox-profile-bio-text">${bioHtml}</p>
                 <button type="button" class="nox-profile-more" hidden aria-expanded="false">Show more</button>
               </div>`
            : ''
        }
        <div class="nox-profile-actions">
          <div id="profile-owner-action"></div>
          <div id="follow-action"></div>
          <div id="profile-zap-action"></div>
        </div>
        <div id="profile-edit-panel" class="hidden mt-4 w-full max-w-2xl"></div>
      </div>
    </div>
  `;
  fillMentionNames(profileSection);

  // A long bio folds at a few lines. The person's addresses and manifesto
  // are still one tap away; the posts are not two screens away.
  const bio: HTMLElement | null =
    profileSection.querySelector('.nox-profile-bio');
  const bioText: HTMLElement | null = profileSection.querySelector(
    '.nox-profile-bio-text',
  );
  const more: HTMLButtonElement | null =
    profileSection.querySelector('.nox-profile-more');
  if (bio && bioText && more) {
    // Measured after layout: the clamp is CSS, and only the browser knows
    // whether it cut anything.
    requestAnimationFrame((): void => {
      if (bioText.scrollHeight > bioText.clientHeight + 2) {
        more.hidden = false;
      }
    });
    more.addEventListener('click', (): void => {
      const folded: boolean = bio.dataset.folded !== 'false';
      // Where this button sat on screen before the bio changed height.
      // Folding removes lines above it, so the page keeps its scroll offset
      // while the content moves up, and the reader who tapped "Show less"
      // ends up somewhere down the timeline. Scrolling by the same amount
      // leaves the button under the finger that pressed it.
      const before: number = more.getBoundingClientRect().top;
      bio.dataset.folded = folded ? 'false' : 'true';
      more.textContent = folded ? 'Show less' : 'Show more';
      more.setAttribute('aria-expanded', folded ? 'true' : 'false');
      const shift: number = more.getBoundingClientRect().top - before;
      if (shift !== 0) {
        window.scrollBy({ top: shift, behavior: 'instant' });
      }
    });
  }

  // How many people they follow, from their own kind 3. No answer, or no
  // list on these relays, leaves the number out rather than showing a zero.
  void (async (): Promise<void> => {
    try {
      const following = await fetchFollowSet(pubkey, getRelays());
      if (!following) return;
      if (profileSection.dataset.pubkey !== pubkey) return;
      const element: HTMLElement | null =
        profileSection.querySelector('#profile-following');
      if (!element) return;
      element.innerHTML = `following <b>${following.size.toLocaleString()}</b>`;
      element.hidden = false;
    } catch {
      // Nobody answered; the line simply has one fewer thing on it.
    }
  })();

  // Filled in after the fact, like the NIP-05 badge below: a status is
  // decoration, and nothing about the profile should wait on it. A lookup that
  // finds nothing and a lookup that fails render the same way, which is not at
  // all.
  void (async (): Promise<void> => {
    const status = await fetchUserStatus({
      pubkeyHex: pubkey,
      relays: getRelays(),
    });
    if (!status) {
      return;
    }
    const element: HTMLElement | null =
      profileSection.querySelector('#profile-status');
    if (!element) {
      return;
    }
    element.textContent = status.text;
    element.dataset.empty = 'false';
    if (status.url) {
      const link: HTMLAnchorElement = document.createElement('a');
      link.href = status.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'underline';
      link.textContent = status.text;
      element.replaceChildren(link);
    }
    element.classList.remove('hidden');
  })();

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
          icon.closest('.nox-profile-nip05')?.classList.add('is-verified');
        }
      } catch (error: unknown) {
        console.warn('[Profile] Failed to verify NIP-05:', error);
      }
    })();
  }
}

/**
 * The name the person chose, for the heading. The address (NIP-05) is
 * shown on its own line as an address; it is not a name, and the line
 * that mixes them - the timeline's `getDisplayName` - is for a card, where
 * there is room for one string only.
 */
export function profileName(npub: Npub, profile: NostrProfile | null): string {
  const chosen: string | undefined =
    profile?.display_name?.trim() || profile?.name?.trim();
  return chosen || `${npub.slice(0, 12)}…`;
}

export function setupProfileZapButton(
  pubkey: PubkeyHex,
  npub: Npub,
  profile: NostrProfile | null,
  profileSection: HTMLElement,
): void {
  const renderProfileData: NostrProfile | null = getAuthoritativeProfile(
    pubkey,
    profile,
  );
  const zapAction: HTMLElement | null = profileSection.querySelector(
    '#profile-zap-action',
  );
  if (!zapAction) {
    return;
  }

  const zapIdentifier: string | undefined =
    renderProfileData?.lud16 || renderProfileData?.lud06;
  if (!zapIdentifier) {
    zapAction.innerHTML = '';
    return;
  }

  zapAction.innerHTML = `
    <button
      id="profile-zap-trigger"
      class="nox-secondary-button py-2 px-4 text-sm"
      title="Zap via Lightning"
    >
      ⚡ Zap
    </button>
  `;

  const trigger: HTMLButtonElement | null = profileSection.querySelector(
    '#profile-zap-trigger',
  );
  if (!trigger) {
    return;
  }

  trigger.addEventListener('click', (): void => {
    openZapComposer({
      targetType: 'profile',
      recipientPubkey: pubkey,
      recipientName: getDisplayName(npub, renderProfileData),
      recipientProfile: renderProfileData,
    });
  });
}

export function setupProfileEditor(
  pubkey: PubkeyHex,
  npub: Npub,
  profile: NostrProfile | null,
  profileSection: HTMLElement,
  options: ProfileEditorOptions,
): void {
  const ownerAction: HTMLElement | null = profileSection.querySelector(
    '#profile-owner-action',
  );
  const editPanel: HTMLElement | null = profileSection.querySelector(
    '#profile-edit-panel',
  );
  if (!ownerAction || !editPanel) {
    return;
  }

  const storedPubkey: PubkeyHex | null = getStoredPubkey();
  if (!storedPubkey || storedPubkey !== pubkey) {
    ownerAction.innerHTML = '';
    editPanel.innerHTML = '';
    editPanel.classList.add('hidden');
    return;
  }

  const canSign: boolean = canSignProfileMetadata();
  ownerAction.innerHTML = `
    <button
      id="profile-edit-toggle"
      class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
    >
      Edit profile
    </button>
  `;

  editPanel.innerHTML = `
    <form id="profile-edit-form" class="rounded-xl border border-slate-200 bg-white/95 p-4 text-left shadow-sm backdrop-blur">
      <div class="grid gap-4 md:grid-cols-2">
        <label class="block text-sm font-medium text-slate-700">
          Display name
          <input name="display_name" type="text" value="${escapeHtml(profile?.display_name || '')}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label class="block text-sm font-medium text-slate-700">
          Username
          <input name="name" type="text" value="${escapeHtml(profile?.name || '')}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label class="block text-sm font-medium text-slate-700">
          NIP-05
          <input name="nip05" type="text" value="${escapeHtml(profile?.nip05 || '')}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="name@example.com" />
        </label>
        <label class="block text-sm font-medium text-slate-700">
          Avatar URL
          <input name="picture" type="url" value="${escapeHtml(profile?.picture || '')}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label class="block text-sm font-medium text-slate-700">
          Banner URL
          <input name="banner" type="url" value="${escapeHtml(profile?.banner || '')}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label class="block text-sm font-medium text-slate-700">
          Website
          <input name="website" type="text" value="${escapeHtml((profile?.website || profile?.url || '') as string)}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="example.com" />
        </label>
        <label class="block text-sm font-medium text-slate-700">
          Lightning Address
          <input name="lud16" type="text" value="${escapeHtml(profile?.lud16 || '')}" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="name@getalby.com" />
        </label>
        <label class="block text-sm font-medium text-slate-700 md:col-span-2">
          About
          <textarea name="about" rows="4" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">${escapeHtml(profile?.about || '')}</textarea>
        </label>
      </div>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button
          id="profile-edit-submit"
          type="submit"
          class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700"
        >
          Save profile
        </button>
        <button
          id="profile-edit-cancel"
          type="button"
          class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
        >
          Cancel
        </button>
        <span id="profile-edit-status" class="text-sm text-slate-500">
          ${canSign ? 'Ready to publish kind 0 metadata' : 'Sign-in required to edit profile'}
        </span>
      </div>
    </form>
  `;

  editPanel.classList.add('hidden');

  const toggleButton: HTMLButtonElement | null = profileSection.querySelector(
    '#profile-edit-toggle',
  );
  const form: HTMLFormElement | null =
    profileSection.querySelector('#profile-edit-form');
  const submitButton: HTMLButtonElement | null = profileSection.querySelector(
    '#profile-edit-submit',
  );
  const cancelButton: HTMLButtonElement | null = profileSection.querySelector(
    '#profile-edit-cancel',
  );
  const statusEl: HTMLElement | null = profileSection.querySelector(
    '#profile-edit-status',
  );
  if (!toggleButton || !form || !submitButton || !cancelButton || !statusEl) {
    return;
  }

  let isSubmitting: boolean = false;

  const syncFormState = (): void => {
    toggleButton.disabled = isSubmitting;
    submitButton.disabled = isSubmitting;
    if (isSubmitting) {
      toggleButton.classList.add('opacity-60', 'cursor-not-allowed');
      submitButton.classList.add('opacity-60', 'cursor-not-allowed');
      cancelButton.disabled = true;
      cancelButton.classList.add('opacity-60', 'cursor-not-allowed');
      return;
    }

    toggleButton.classList.remove('opacity-60', 'cursor-not-allowed');
    submitButton.classList.remove('opacity-60', 'cursor-not-allowed');
    cancelButton.disabled = false;
    cancelButton.classList.remove('opacity-60', 'cursor-not-allowed');
  };

  const closeEditor = (): void => {
    editPanel.classList.add('hidden');
    statusEl.textContent = canSignProfileMetadata()
      ? 'Ready to publish kind 0 metadata'
      : 'Sign-in required to edit profile';
  };

  toggleButton.addEventListener('click', (): void => {
    if (editPanel.classList.contains('hidden')) {
      editPanel.classList.remove('hidden');
      statusEl.textContent = canSignProfileMetadata()
        ? 'Ready to publish kind 0 metadata'
        : 'Sign-in required to edit profile';
      return;
    }
    closeEditor();
  });

  cancelButton.addEventListener('click', (): void => {
    form.reset();
    closeEditor();
  });

  form.addEventListener('submit', async (event: Event): Promise<void> => {
    event.preventDefault();

    if (!canSignProfileMetadata()) {
      statusEl.textContent = 'Sign-in required to edit profile';
      alert(
        'Sign-in required to edit profile. Please log in with extension or private key.',
      );
      return;
    }

    isSubmitting = true;
    syncFormState();
    statusEl.textContent = 'Publishing profile...';

    try {
      const nextProfile: NostrProfile = buildEditableProfileDraft(
        profile,
        form,
      );
      const signedEvent: NostrEvent = await signProfileMetadataEvent(
        pubkey,
        nextProfile,
      );
      await options.publishEvent(signedEvent, options.getRelays());
      await cacheResolvedProfile(pubkey, nextProfile);
      renderProfile(pubkey, npub, nextProfile, profileSection);
      setupProfileZapButton(pubkey, npub, nextProfile, profileSection);
      setupProfileEditor(pubkey, npub, nextProfile, profileSection, options);
      // Told last: the section has been redrawn, and whatever the page
      // mounts on it - the Posts/Replies tabs - has to be put back now.
      options.onProfileUpdated?.(nextProfile);
    } catch (error: unknown) {
      console.error('[Profile] Failed to publish metadata:', error);
      statusEl.textContent = 'Failed to publish profile';
      alert('Failed to publish profile. Please try again.');
    } finally {
      isSubmitting = false;
      syncFormState();
    }
  });

  syncFormState();
}
