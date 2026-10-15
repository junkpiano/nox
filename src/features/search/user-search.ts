import type { NostrProfile } from '../../../types/nostr';
import { avatarErrorAttribute } from '../../common/avatar.js';
import { getProfile, storeProfile } from '../../common/db/index.js';
import { escapeHtml } from '../../common/escape-html.js';
/**
 * Finding a person, rather than a post.
 *
 * A NIP-50 relay answers `{kinds:[0], search}` with profiles ordered by how
 * recently their owner last edited them. That is not the order anyone looking
 * for a person wants: searching "jack" returns airport bots, Bluesky bridges
 * and a wall of identically-named strangers, while the well-known Jack is
 * absent because he has not touched his profile in months.
 *
 * So the relay's order is treated as raw material and the list is re-sorted
 * against signals we already hold - who the viewer follows, whether the name
 * actually matches, whether the profile claims a NIP-05 at all. None of them
 * costs a request. Follower counts would rank better, but counting followers
 * needs an indexer, and this app has no backend to run one.
 */

import { getAvatarURL, shortenNpub } from '../../utils/utils.js';
import {
  MAX_ABOUT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NIP05_LENGTH,
  oneLine,
  type UserSearchResult,
} from './user-ranking.js';

// Re-exported so every existing importer of this module keeps working.
export {
  decodePubkeyQuery,
  rankUserResults,
  type UserSearchResult,
} from './user-ranking.js';

/**
 * Reconciles a search hit against the store.
 *
 * A search relay's copy of a profile may be older than the one already
 * stored, and the store is the authoritative render source. So a stored
 * profile wins and is returned unchanged; a pubkey with none is filled in
 * from the search result, which populates a gap without overwriting anything.
 */
async function reconcileWithStore(
  result: UserSearchResult,
): Promise<NostrProfile> {
  const stored: NostrProfile | null = await getProfile(result.pubkey);
  if (stored) return stored;
  void storeProfile(result.pubkey, result.profile);
  return result.profile;
}

function renderUserRow(result: UserSearchResult): string {
  const profile: NostrProfile = result.profile;
  const name: string =
    oneLine(profile.display_name, MAX_NAME_LENGTH) ||
    oneLine(profile.name, MAX_NAME_LENGTH) ||
    shortenNpub(result.npub);
  const nip05: string = oneLine(profile.nip05, MAX_NIP05_LENGTH);
  const about: string = oneLine(profile.about, MAX_ABOUT_LENGTH);
  // The picture URL is whatever its owner put in their profile, so it is
  // reduced to a scheme an <img> may be pointed at before it becomes a src.
  const avatar: string = getAvatarURL(result.pubkey, profile);
  const safeNpub: string = escapeHtml(result.npub);
  const safePubkey: string = escapeHtml(result.pubkey);

  return `
    <a href="/${safeNpub}" class="user-result flex items-start gap-3 py-3 rounded-lg hover:bg-gray-100 transition-colors" data-pubkey="${safePubkey}">
      <img src="${escapeHtml(avatar)}" alt="" class="w-10 h-10 rounded-full object-cover flex-shrink-0"
           onerror="${avatarErrorAttribute(result.pubkey)}" />
      <div class="min-w-0 flex-1">
        <div class="font-semibold text-gray-800 text-sm truncate">${escapeHtml(name)}</div>
        <div class="text-xs text-gray-500 truncate">${escapeHtml(nip05 || shortenNpub(result.npub))}</div>
        ${about ? `<div class="text-xs text-gray-600 mt-0.5 truncate">${escapeHtml(about)}</div>` : ''}
      </div>
    </a>
  `;
}

/**
 * Draws the People block above the post results, or nothing when empty.
 *
 * An empty block is worse than no block: it takes a line of the page to say
 * that a thing the reader did not ask about was not found.
 */
export async function renderUserResults(
  container: HTMLElement,
  results: UserSearchResult[],
): Promise<void> {
  if (results.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  // Looked up together, before any row is drawn: the rows are one string.
  const reconciled: UserSearchResult[] = await Promise.all(
    results.map(
      async (result: UserSearchResult): Promise<UserSearchResult> => ({
        ...result,
        profile: await reconcileWithStore(result),
      }),
    ),
  );

  container.style.display = '';
  container.innerHTML = `
    <h3 class="font-semibold text-sm text-gray-800 mb-2">People (${results.length})</h3>
    <div class="space-y-1 mb-6">
      ${reconciled.map(renderUserRow).join('')}
    </div>
  `;
}
