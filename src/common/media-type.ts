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

/**
 * The moment a video should show before anyone presses play.
 *
 * Not zero: some encoders put a black or near-black frame first, and a browser
 * asked for 0 may simply not seek at all. A tenth of a second is past that and
 * still the opening image.
 */
const POSTER_FRAGMENT: string = '#t=0.1';

/**
 * Asks the browser to paint a frame instead of a black rectangle.
 *
 * `preload="metadata"` fetches enough to know a video's duration and no more,
 * which leaves it rendering as a black box until someone plays it - you cannot
 * tell what you are about to watch. A `#t=` media fragment tells the browser to
 * seek there and show that frame, one more range request rather than the file.
 *
 * A URL that already carries a fragment is returned unchanged: someone linking
 * to a moment in a video means that moment.
 *
 * The obvious alternative was the thumbnail NIP-92 allows in an `imeta` tag. Of
 * eight video posts sampled off live relays, three carried an `imeta` tag and
 * none carried a thumbnail, so that path is not worth a branch yet.
 */
export function withPosterFrame(url: string): string {
  const hash: number = url.indexOf('#');
  if (hash < 0) {
    return `${url}${POSTER_FRAGMENT}`;
  }
  // A bare trailing `#` says nothing, so it is ours to replace.
  if (hash === url.length - 1) {
    return `${url.slice(0, hash)}${POSTER_FRAGMENT}`;
  }
  return url;
}
