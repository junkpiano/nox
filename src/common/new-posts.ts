/**
 * Posts that arrived after the timeline was drawn, held until asked for.
 *
 * A timeline that inserts new posts at the top while somebody is reading
 * moves the words out from under their eyes; one that floats a banner over
 * the list hides what they were reading instead. Neither is what a reader
 * asked for. So new posts wait here, the list shows one thin row at its top
 * saying how many are waiting, and a tap on that row lets them in all at
 * once - after which the row goes and the list scrolls to the top so the new
 * posts are what is on screen.
 *
 * Nothing here knows about relays or the screen. Each timeline decides what
 * counts as a post and feeds this only what it would actually show: muted,
 * deleted and machine-written posts are removed before they get here, so the
 * number on the row is the number of posts a tap will add.
 */

export interface NewPostsBuffer<T> {
  /**
   * Offers posts that may be new. Ones already shown, or already waiting,
   * are ignored. Returns how many are now waiting.
   */
  add(candidates: T[]): number;
  /** How many are waiting. */
  count(): number;
  /** Empties the buffer, newest first. */
  take(): T[];
  /** Forgets what is waiting - after a full reload, which shows everything. */
  clear(): void;
}

export interface NewPostsOptions<T> {
  /** The identity a post is deduplicated by. */
  keyOf(post: T): string;
  /** Whether the timeline already shows this key. */
  isShown(key: string): boolean;
  /** Seconds since the epoch, for ordering. */
  createdAt(post: T): number;
}

export function createNewPostsBuffer<T>(
  options: NewPostsOptions<T>,
): NewPostsBuffer<T> {
  const waiting: Map<string, T> = new Map();

  return {
    add(candidates: T[]): number {
      for (const post of candidates) {
        const key: string = options.keyOf(post);
        if (waiting.has(key) || options.isShown(key)) continue;
        waiting.set(key, post);
      }
      return waiting.size;
    },
    count(): number {
      return waiting.size;
    },
    take(): T[] {
      const posts: T[] = Array.from(waiting.values()).sort(
        (a: T, b: T): number => options.createdAt(b) - options.createdAt(a),
      );
      waiting.clear();
      return posts;
    },
    clear(): void {
      waiting.clear();
    },
  };
}

/** What the row says. */
export function newPostsLabel(count: number): string {
  return count === 1 ? '1 new post' : `${count} new posts`;
}

/**
 * Where to resume polling from: one second past the newest post shown, so a
 * relay is asked only for what it has not already sent. `null` when nothing
 * is shown yet, in which case there is nothing to be newer than.
 */
export function nextSince(newestShownCreatedAt: number | null): number | null {
  return newestShownCreatedAt === null ? null : newestShownCreatedAt + 1;
}
