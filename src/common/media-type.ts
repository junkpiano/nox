/**
 * Telling an image from a video, so each is rendered by an element that can
 * actually play it.
 *
 * These used to be one branch. A video went into an `<img>`, where no browser
 * can decode it - but the browser only learns that after downloading the whole
 * file, and the gallery then fetched it a second time into another `<img>` when
 * someone tapped to enlarge. The post that prompted this carries a twenty
 * megabyte MP4 served as `video/mp4` with `nosniff`, so there was never a
 * chance of it rendering: just the download, twice.
 *
 * Extensions are all we have. A HEAD request per URL would be more honest about
 * the content type, but it costs a round trip per link before anything can be
 * drawn, and media hosts on Nostr do name their files.
 */

export type MediaKind = 'image' | 'video';

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpeg',
  'jpg',
  'gif',
  'png',
  'webp',
  'svg',
]);

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4',
  'webm',
  'mov',
  'avi',
]);

/**
 * Returns what the URL points at, or null when it is not media.
 *
 * The extension is read off the path rather than the whole URL, so a signed
 * link keeps its type and a hostname like `mp4.example.com` does not acquire
 * one.
 */
export function classifyMediaUrl(url: string): MediaKind | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }

  const lastDot: number = path.lastIndexOf('.');
  if (lastDot < 0) {
    return null;
  }
  const extension: string = path.slice(lastDot + 1).toLowerCase();

  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }
  return null;
}
