/**
 * Reading further back: the cursor, the merge, and knowing when to stop.
 *
 * A timeline is asked for a page at a time, each page older than the last.
 * The cursor is the oldest event held so far, and the next page is asked for
 * with `until` one second before it, because `until` is inclusive and a page
 * that ended exactly on a second would otherwise be fetched again.
 *
 * Stopping is the part that goes wrong. A relay that has nothing older sends
 * an empty page; a relay that ignores `until` sends the same page again; and
 * a page whose every post is muted or machine-written looks empty after
 * filtering while the cursor has in fact moved. The first two mean there is
 * nothing more. The third means keep going, up to a limit. This module makes
 * those calls on plain numbers so both apps make them the same way.
 */

/** Posts per page. Small enough to arrive quickly, large enough to scroll. */
export const PAGE_LIMIT: number = 100;
/** How many posts a timeline holds before it stops reading further back. */
export const MAX_HELD_POSTS: number = 2000;
/**
 * How many pages in a row may add nothing visible - every post filtered out -
 * before the timeline stops looking. Each still moved the cursor.
 */
export const MAX_FILTERED_PAGES: number = 3;

/** The `until` for the next page, or null when nothing is held yet. */
export function nextUntil(oldestCreatedAt: number | null): number | null {
  return oldestCreatedAt === null ? null : oldestCreatedAt - 1;
}

/** The oldest moment among these, or null for none. */
export function oldestOf(events: { created_at: number }[]): number | null {
  let oldest: number | null = null;
  for (const event of events) {
    if (oldest === null || event.created_at < oldest) oldest = event.created_at;
  }
  return oldest;
}

export type PageEnd = 'exhausted' | 'stalled' | 'cap';

export interface PageJudgement {
  /** The cursor after this page. */
  oldestCreatedAt: number | null;
  /** Whether asking for another page is worth it. */
  hasMore: boolean;
  /** Why not, when it is not. */
  end: PageEnd | null;
}

/**
 * What a page of raw events means for the cursor and for continuing.
 *
 * `newIds` is how many of the page's events were not already held - a relay
 * sending the same page twice counts as nothing new. `heldAfter` is how many
 * posts the timeline holds once this page is merged.
 */
export function judgePage(args: {
  previousOldest: number | null;
  page: { id: string; created_at: number }[];
  newIds: number;
  heldAfter: number;
}): PageJudgement {
  const { previousOldest, page, newIds, heldAfter } = args;
  if (page.length === 0 || newIds === 0) {
    return {
      oldestCreatedAt: previousOldest,
      hasMore: false,
      end: 'exhausted',
    };
  }
  const pageOldest: number | null = oldestOf(page);
  const advanced: boolean =
    pageOldest !== null &&
    (previousOldest === null || pageOldest < previousOldest);
  if (!advanced) {
    return { oldestCreatedAt: previousOldest, hasMore: false, end: 'stalled' };
  }
  if (heldAfter >= MAX_HELD_POSTS) {
    return { oldestCreatedAt: pageOldest, hasMore: false, end: 'cap' };
  }
  return { oldestCreatedAt: pageOldest, hasMore: true, end: null };
}

/**
 * Two runs of posts as one, each post once, newest first.
 *
 * Used in both directions - older pages joining at the bottom, a refresh
 * joining at the top - so a post that arrives twice, from two relays or from
 * two fetches that overlapped by a second, is shown once. The existing copy
 * wins, which keeps a row's identity stable for the list that draws it.
 */
export function mergePosts<T>(
  existing: T[],
  incoming: T[],
  keyOf: (post: T) => string,
  createdAt: (post: T) => number,
): T[] {
  const seen: Set<string> = new Set();
  const merged: T[] = [];
  for (const post of [...existing, ...incoming]) {
    const key: string = keyOf(post);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(post);
  }
  return merged.sort((a: T, b: T): number => createdAt(b) - createdAt(a));
}
