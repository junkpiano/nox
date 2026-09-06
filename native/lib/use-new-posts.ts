/**
 * Polls for posts newer than the timeline and holds them until asked for.
 *
 * The web app checks its relays every thirty seconds; this does the same,
 * from one second past the newest post it has seen, and hands what comes
 * back to the shared buffer in `src/common/new-posts.ts`. The list shows the
 * count on a thin row at its top; `showNew` lets the waiting posts in.
 *
 * Nothing about the posts already on screen changes while a poll runs - not
 * their order, not the scroll position. That is the whole reason the new
 * ones wait.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createNewPostsBuffer,
  type NewPostsBuffer,
  nextSince,
} from '../../src/common/new-posts';
import { loadNewerPosts, type TimelinePost } from './home-timeline';

const POLL_MS: number = 30000;

export interface NewPosts {
  /** How many are waiting to be shown. */
  pendingCount: number;
  /** Lets the waiting posts into the list, newest first. */
  showNew: () => void;
  /** After a full reload: nothing is waiting, everything is on screen. */
  forget: () => void;
}

export function useNewPosts(
  filter: Record<string, unknown> | null,
  posts: TimelinePost[],
  setPosts: (update: (previous: TimelinePost[]) => TimelinePost[]) => void,
): NewPosts {
  const shown = useRef<Set<string>>(new Set());
  shown.current = new Set(posts.map((post: TimelinePost): string => post.key));

  // The newest moment heard of, shown or waiting, so a poll does not ask for
  // what a previous poll already brought back.
  const newestSeen = useRef<number | null>(null);
  for (const post of posts) {
    if (newestSeen.current === null || post.createdAt > newestSeen.current) {
      newestSeen.current = post.createdAt;
    }
  }

  const buffer = useRef<NewPostsBuffer<TimelinePost>>(
    createNewPostsBuffer<TimelinePost>({
      keyOf: (post: TimelinePost): string => post.key,
      isShown: (key: string): boolean => shown.current.has(key),
      createdAt: (post: TimelinePost): number => post.createdAt,
    }),
  );
  const [pendingCount, setPendingCount] = useState(0);

  const enabled: boolean = filter !== null && posts.length > 0;
  useEffect((): (() => void) | undefined => {
    if (!enabled || !filter) return undefined;
    let cancelled: boolean = false;
    let busy: boolean = false;

    const poll = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const since: number | null = nextSince(newestSeen.current);
        if (since === null) return;
        const fresh: TimelinePost[] = await loadNewerPosts(filter, since);
        if (cancelled) return;
        for (const post of fresh) {
          if (
            newestSeen.current === null ||
            post.createdAt > newestSeen.current
          ) {
            newestSeen.current = post.createdAt;
          }
        }
        setPendingCount(buffer.current.add(fresh));
      } catch {
        // A failed poll is tried again next time.
      } finally {
        busy = false;
      }
    };

    const timer = setInterval((): void => {
      void poll();
    }, POLL_MS);
    return (): void => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, filter]);

  const showNew = useCallback((): void => {
    const fresh: TimelinePost[] = buffer.current.take();
    setPendingCount(0);
    if (fresh.length === 0) return;
    setPosts((previous: TimelinePost[]): TimelinePost[] => {
      const keys: Set<string> = new Set(
        previous.map((post: TimelinePost): string => post.key),
      );
      const added: TimelinePost[] = fresh.filter(
        (post: TimelinePost): boolean => !keys.has(post.key),
      );
      return [...added, ...previous].sort(
        (a: TimelinePost, b: TimelinePost): number => b.createdAt - a.createdAt,
      );
    });
  }, [setPosts]);

  const forget = useCallback((): void => {
    buffer.current.clear();
    newestSeen.current = null;
    setPendingCount(0);
  }, []);

  return { pendingCount, showNew, forget };
}
