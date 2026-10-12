/**
 * Text handed to nox by a link: `/post?content=…`.
 *
 * The address nostter uses, so the bookmarklets and browser extensions
 * written for it work here too; `text` and `url` are read as well, which is
 * what a browser's own share sheet sends. The text waits in this tab until
 * a composer can take it - straight away when signed in, after sign-in
 * otherwise - and the address is put back to `/` so a reload does not ask
 * again.
 */

const KEY: string = 'nox_share_draft';
/** Longer than any post someone means to share; a link is not a file. */
const MAX_LENGTH: number = 10_000;

/** The text a share link carries, or null when it carries none. */
export function shareTextFrom(params: URLSearchParams): string | null {
  const content: string = (params.get('content') ?? '').trim();
  const text: string = content
    ? content
    : [params.get('text'), params.get('url')]
        .map((part: string | null): string => (part ?? '').trim())
        .filter((part: string): boolean => part.length > 0)
        .join(' ');
  return text ? text.slice(0, MAX_LENGTH) : null;
}

export function keepShareDraft(text: string): void {
  try {
    sessionStorage.setItem(KEY, text);
  } catch {
    // Private mode without storage: the link opens nox, the text is lost.
  }
}

/** The waiting text, removed as it is taken. */
export function takeShareDraft(): string | null {
  try {
    const text: string | null = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return text;
  } catch {
    return null;
  }
}
