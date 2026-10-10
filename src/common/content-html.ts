/**
 * A post's text as HTML.
 *
 * The parts - links, pictures, mentions, quotes, custom emoji - are found by
 * the parser the phone uses too (`content-segments.ts`); this only decides
 * what each looks like on the web. The card renderer used to find them
 * itself, in seven regex passes over the same string, and the profile page
 * kept a third copy for the bio.
 *
 * Everything that reaches the markup is escaped here. A URL becomes a link
 * only with an http(s) scheme; a picture is an <img> only as itself.
 */

import { nip19 } from 'nostr-tools';
import type { PubkeyHex } from '../../types/nostr';
import { replaceEmojiShortcodes } from '../utils/utils.js';
import {
  type ContentSegment,
  parseContentSegments,
  parseEmojiSegments,
  readTopicTags,
  shortIdentifier,
} from './content-segments.js';
import { readEmojiTags } from './custom-emoji.js';
import { escapeHtml } from './escape-html.js';
import { withPosterFrame } from './media-type.js';

export interface RenderedContent {
  html: string;
  /** Pictures, in order: the gallery's list; each <img> carries its index. */
  images: string[];
  /** Links that are neither picture nor video, for the preview cards. */
  links: string[];
  /** Mention identifier (npub1…, nprofile1…) to pubkey, for names filled in later. */
  mentions: Map<string, PubkeyHex>;
  /** Quoted notes (nevent1…, note1…), each once, for the cards under the post. */
  quotes: string[];
}

export interface ContentHtmlOptions {
  /** Pictures and videos as links to themselves, not as themselves. */
  energySaving?: boolean;
  /** A line of prose, not a post: every link is a link, a quote stays text. */
  inline?: boolean;
  /** A name for a mention when one is known; null means the short identifier. */
  mentionLabel?: (pubkey: PubkeyHex) => string | null;
}

/** An http(s) URL in canonical form, or null for any other scheme. */
export function normalizeHttpUrl(url: string): string | null {
  try {
    const parsed: URL = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="text-blue-500 underline">${escapeHtml(label)}</a>`;
}

function emojiImage(shortcode: string, url: string): string {
  const code: string = escapeHtml(shortcode);
  return `<img src="${escapeHtml(url)}" alt=":${code}:" title=":${code}:" class="nox-emoji inline-block align-text-bottom h-5 w-5 mx-0.5" loading="lazy" decoding="async" />`;
}

function renderSegment(
  segment: ContentSegment,
  options: ContentHtmlOptions,
  out: RenderedContent,
): string {
  switch (segment.kind) {
    case 'text':
      return replaceEmojiShortcodes(escapeHtml(segment.text));
    case 'hashtag':
      // The same address the phone opens: /t/<tag>, lowercased as NIP-12 `t`.
      return `<a href="/t/${encodeURIComponent(segment.tag)}" class="hashtag-link">${escapeHtml(segment.text)}</a>`;
    case 'emoji':
      return emojiImage(segment.shortcode, segment.url);
    case 'mention': {
      if (!segment.pubkey) return escapeHtml(segment.text);
      const identifier: string = segment.text.replace(/^nostr:/i, '');
      const isNpub: boolean = identifier.toLowerCase().startsWith('npub1');
      const npub: string = isNpub
        ? identifier
        : nip19.npubEncode(segment.pubkey);
      const label: string =
        options.mentionLabel?.(segment.pubkey) ??
        `@${shortIdentifier(identifier)}`;
      out.mentions.set(identifier, segment.pubkey);
      return `<a href="/${escapeHtml(npub)}" class="text-indigo-600 underline mention-link" ${isNpub ? 'data-mention-npub' : 'data-mention-nprofile'}="${escapeHtml(identifier)}" data-pubkey="${segment.pubkey}">${escapeHtml(label)}</a>`;
    }
    case 'event': {
      if (options.inline || !segment.eventId) return escapeHtml(segment.text);
      const identifier: string = segment.text.replace(/^nostr:/i, '');
      if (!out.quotes.includes(identifier)) out.quotes.push(identifier);
      // The card under the post is the quote; the identifier would be
      // thirty characters of bech32 in the middle of a sentence.
      return '';
    }
    case 'url': {
      if (/^nostr:/i.test(segment.text)) {
        return link(segment.url, `${segment.text.slice(0, 24)}…`);
      }
      const safe: string | null = normalizeHttpUrl(segment.url);
      if (!safe) return escapeHtml(segment.text);
      if (!segment.media || options.inline) {
        out.links.push(safe);
        return link(safe, safe);
      }
      if (options.energySaving) {
        const fileName: string = safe.split('/').pop() || 'media';
        const label: string =
          segment.media === 'video' ? '🎬 Video: ' : '🖼️ Image: ';
        return `<div class="my-2 p-2 bg-gray-100 rounded border border-gray-300"><span class="text-gray-600 text-xs">${label}</span><a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer" class="text-blue-500 underline text-sm">${escapeHtml(fileName)}</a></div>`;
      }
      if (segment.media === 'video') {
        // preload="metadata" so a timeline full of videos costs a few
        // headers rather than the files themselves, and no autoplay: a feed
        // that starts moving on its own is a feed you have to fight. Kept
        // out of `images` - the gallery is an <img>, which is exactly what a
        // video must not be handed to.
        return `<video src="${escapeHtml(withPosterFrame(safe))}" class="event-video my-2 max-w-full rounded shadow" controls preload="metadata" playsinline></video>`;
      }
      out.images.push(safe);
      return `<img src="${escapeHtml(safe)}" alt="Image" class="my-2 max-w-full rounded shadow cursor-zoom-in event-image" loading="lazy" data-image-index="${out.images.length - 1}" />`;
    }
    default:
      return '';
  }
}

export function renderContentHtml(
  content: string,
  tags: string[][],
  options: ContentHtmlOptions = {},
): RenderedContent {
  const out: RenderedContent = {
    html: '',
    images: [],
    links: [],
    mentions: new Map(),
    quotes: [],
  };
  const parts: string[] = [];
  for (const segment of parseContentSegments(
    content,
    readEmojiTags(tags),
    readTopicTags(tags),
  )) {
    parts.push(renderSegment(segment, options, out));
  }
  out.html = parts.join('');
  return out;
}

/** A line that is only a line - a quoted post's preview - with its emoji. */
export function renderEmojiHtml(text: string, tags: string[][]): string {
  return parseEmojiSegments(text, readEmojiTags(tags))
    .map((segment: ContentSegment): string =>
      segment.kind === 'emoji'
        ? emojiImage(segment.shortcode, segment.url)
        : replaceEmojiShortcodes(escapeHtml(segment.text)),
    )
    .join('');
}

/**
 * A custom emoji whose picture will not load becomes its name.
 *
 * The picture lives on whatever host its author chose, and hosts delete
 * files. The browser's broken-image icon says only that something is
 * missing; `:shortcode:` still says which reaction it was. One listener on
 * the document, in the capture phase because `error` does not bubble,
 * covers every emoji however it was drawn.
 */
export function installEmojiFallback(): void {
  document.addEventListener(
    'error',
    (event: Event): void => {
      const target: EventTarget | null = event.target;
      if (
        !(target instanceof HTMLImageElement) ||
        !target.classList.contains('nox-emoji')
      ) {
        return;
      }
      const name: HTMLSpanElement = document.createElement('span');
      name.className = 'nox-emoji-missing';
      name.textContent = target.alt;
      target.replaceWith(name);
    },
    true,
  );
}
