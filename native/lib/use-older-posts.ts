/**
 * Reading further back when the list runs out.
 *
 * The screen says when its end is near; this asks for the page before the
 * oldest post held, adds what comes back to the bottom, and knows when to
 * stop. One request at a time, however often the end is reported. Nothing
 * already on screen moves. A page that arrives after the screen was hidden,
 * or after the timeline was reloaded under a new question, is dropped.
 *
 * The rules - the cursor, the merge, the end conditions, the allowance for
 * pages that were all filtered out - live in `src/common/timeline-paging.ts`
 * and are shared with the web app. This is the React shape of them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  judgePage,
  MAX_FILTERED_PAGES,
  mergePosts,
  nextUntil,
} from '../../src/common/timeline-paging';
import type { NostrEvent } from '../../types/nostr';
import { loadOlderPosts, type TimelinePost } from './home-timeline';

export interface OlderPosts {
  loadingOlder: boolean;
  hasMore: boolean;
  loadOlderError: string | null;
  /** Stopped because the timeline holds as much as it will. */
  atCap: boolean;
  /** Asks for the next page, unless one is already on its way or there is none. */
  loadOlder: () => void;
}

const keyOf = (post: TimelinePost): string => post.key;
const createdAt = (post: TimelinePost): number => post.createdAt;

/** Both runs as one, each post once, newest first. */
export function mergeTimelinePosts(
  existing: TimelinePost[],
  incoming: TimelinePost[],
): TimelinePost[] {
  return mergePosts(existing, incoming, keyOf, createdAt);
}

export function useOlderPosts(args: {
  /**
   * The question the timeline asked. A new object means a new timeline -
   * another account, other relays, another tag - and resets the reading.
   */
  filter: Record<string, unknown> | null;
  /** The oldest raw event the first load brought back. */
  oldestCreatedAt: number | null;
  posts: TimelinePost[];
  setPosts: (update: (previous: TimelinePost[]) => TimelinePost[]) => void;
  /** The first load or a refresh is in flight. */
  busy: boolean;
  /** The screen is on show. */
  active: boolean;
}): OlderPosts {
  const { filter, oldestCreatedAt, posts, setPosts, busy, active } = args;

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadOlderError, setLoadOlderError] = useState<string | null>(null);
  const [atCap, setAtCap] = useState(false);

  // Read at request time rather than captured, so the guard sees the
  // current screen and not the one that existed when the callback was made.
  const cursor = useRef<number | null>(oldestCreatedAt);
  const inflight = useRef(false);
  const hasMoreRef = useRef(true);
  const busyRef = useRef(busy);
  const activeRef = useRef(active);
  const postsRef = useRef(posts);
  const generation = useRef(0);
  busyRef.current = busy;
  activeRef.current = active;
  postsRef.current = posts;

  // A new question starts the reading over from that load's oldest post.
  // biome-ignore lint/correctness/useExhaustiveDependencies: oldestCreatedAt arrives with its filter
  useEffect((): void => {
    generation.current += 1;
    cursor.current = oldestCreatedAt;
    inflight.current = false;
    hasMoreRef.current = true;
    setHasMore(true);
    setAtCap(false);
    setLoadOlderError(null);
    setLoadingOlder(false);
  }, [filter]);

  const loadOlder = useCallback((): void => {
    if (
      inflight.current ||
      !hasMoreRef.current ||
      busyRef.current ||
      !activeRef.current ||
      !filter ||
      cursor.current === null
    ) {
      return;
    }
    inflight.current = true;
    setLoadingOlder(true);
    setLoadOlderError(null);
    const started: number = generation.current;
    const stillWanted = (): boolean => started === generation.current;

    void (async (): Promise<void> => {
      try {
        let previousOldest: number | null = cursor.current;
        let filteredPages: number = 0;
        for (;;) {
          const until: number | null = nextUntil(previousOldest);
          if (until === null) break;

          const page = await loadOlderPosts(filter, until);
          // Reloaded under a new question, or hidden meanwhile: this page
          // belongs to a screen nobody is looking at.
          if (!stillWanted() || !activeRef.current) return;

          const held: Set<string> = new Set(postsRef.current.map(keyOf));
          const newIds: number = page.raw.filter(
            (event: NostrEvent): boolean => !held.has(event.id),
          ).length;
          const fresh: TimelinePost[] = page.posts.filter(
            (post: TimelinePost): boolean => !held.has(post.key),
          );
          const judged = judgePage({
            previousOldest,
            page: page.raw,
            newIds,
            heldAfter: postsRef.current.length + fresh.length,
          });

          cursor.current = judged.oldestCreatedAt;
          if (fresh.length > 0) {
            // Released before the append, not after it. The list reports its
            // end again the moment its content grows, and a report refused
            // while this was still marked in flight was the last one the
            // list would make at that length - the reading stalled until
            // somebody scrolled a screen away and back.
            inflight.current = false;
            setLoadingOlder(false);
            setPosts((previous: TimelinePost[]): TimelinePost[] =>
              mergeTimelinePosts(previous, fresh),
            );
          }

          if (!judged.hasMore) {
            hasMoreRef.current = false;
            setHasMore(false);
            setAtCap(judged.end === 'cap');
            break;
          }
          if (fresh.length > 0) break;

          // The cursor moved and nothing was left to show: every post on the
          // page was muted, withdrawn or machine-written. Look further, a
          // few times, rather than calling that the end.
          filteredPages += 1;
          if (filteredPages >= MAX_FILTERED_PAGES) break;
          previousOldest = judged.oldestCreatedAt;
        }
      } catch (error: unknown) {
        if (stillWanted()) {
          setLoadOlderError(String((error as Error)?.message ?? error));
        }
      } finally {
        if (stillWanted()) {
          inflight.current = false;
          setLoadingOlder(false);
        }
      }
    })();
  }, [filter, setPosts]);

  return { loadingOlder, hasMore, loadOlderError, atCap, loadOlder };
}
