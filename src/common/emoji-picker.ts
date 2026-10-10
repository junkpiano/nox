/**
 * Choosing a reaction: the viewer's custom emoji, and a few everyone has.
 *
 * A small panel under the button that opened it - above, when there is no
 * room below - clamped to the screen so it works at phone width. Focus goes
 * into it and comes back to the button; Escape or a tap outside closes it.
 */

import type { PubkeyHex } from '../../types/nostr';
import { type CustomEmoji, fetchEmojiList } from './emoji-list.js';
import { escapeHtml } from './escape-html.js';
import {
  getReactionAggregate,
  type ReactionAggregate,
} from './reaction-interactions.js';

/** The ones nearly every client offers; the custom ones are the point. */
const COMMON: string[] = ['👍', '😂', '🔥', '🎉', '🙏', '👀', '💯', '😢'];
/** More custom emoji than this, and a filter box helps find one. */
const FILTER_FROM: number = 24;

// ponytail: per-session memory memo; store the kind 10030 list in IndexedDB
// if fetching it once per session ever shows up as slow.
const lists: Map<PubkeyHex, Promise<CustomEmoji[]>> = new Map();

function emojiListFor(
  viewer: PubkeyHex,
  relays: string[],
): Promise<CustomEmoji[]> {
  let list: Promise<CustomEmoji[]> | undefined = lists.get(viewer);
  if (!list) {
    list = fetchEmojiList(viewer, relays).catch((error: unknown) => {
      lists.delete(viewer);
      console.warn('[emoji] Could not load the emoji list:', error);
      return [];
    });
    lists.set(viewer, list);
  }
  return list;
}

let open: { panel: HTMLElement; close: () => void } | null = null;

export function closeEmojiPicker(): void {
  open?.close();
}

export function openEmojiPicker(options: {
  anchor: HTMLElement;
  viewer: PubkeyHex;
  relays: string[];
  onPick: (reaction: ReactionAggregate) => void;
}): void {
  const { anchor } = options;
  // A second tap on the same button closes it.
  if (open && open.panel.dataset.for === anchor.dataset.pickerId) {
    open.close();
    return;
  }
  open?.close();
  anchor.dataset.pickerId ||= Math.random().toString(36).slice(2);

  const panel: HTMLDivElement = document.createElement('div');
  panel.className = 'nox-emoji-picker';
  panel.dataset.for = anchor.dataset.pickerId;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Choose a reaction');
  panel.innerHTML = `
    <div class="nox-emoji-common">${COMMON.map(
      (emoji: string): string =>
        `<button type="button" class="nox-emoji-choice" data-emoji="${emoji}" aria-label="${emoji}">${emoji}</button>`,
    ).join('')}</div>
    <div class="nox-emoji-custom"><p class="nox-emoji-note">Loading your emoji…</p></div>
  `;
  document.body.appendChild(panel);

  // Under the button, or over it when the screen ends first.
  const place = (): void => {
    const rect: DOMRect = anchor.getBoundingClientRect();
    const width: number = panel.offsetWidth;
    const left: number = Math.min(
      Math.max(8, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - 8,
    );
    const below: number = rect.bottom + 6;
    const top: number =
      below + panel.offsetHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - panel.offsetHeight - 6)
        : below;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };
  place();

  const choose = (reaction: ReactionAggregate): void => {
    close();
    options.onPick(reaction);
  };
  panel.addEventListener('click', (event: MouseEvent): void => {
    event.stopPropagation();
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button.nox-emoji-choice',
    );
    if (!button) return;
    const { emoji, shortcode, url } = button.dataset;
    // Built by the same reader the badges use, so the new reaction joins
    // its badge rather than starting one of its own.
    if (shortcode && url) {
      choose(
        getReactionAggregate(`:${shortcode}:`, [['emoji', shortcode, url]]),
      );
    } else if (emoji) {
      choose(getReactionAggregate(emoji, []));
    }
  });

  const onOutside = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node) && event.target !== anchor) {
      close();
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      anchor.focus();
    }
  };
  // The page moving under a fixed panel would leave it pointing at nothing.
  const onScroll = (): void => close();
  // Next tick: the click that opened it must not also close it.
  const arming = setTimeout(
    (): void => document.addEventListener('click', onOutside),
    0,
  );
  // A new page, or the post it belongs to gone: nothing left to react to.
  const onRoute = (): void => close();
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('app-route-changed', onRoute);
  const watch = setInterval((): void => {
    if (!anchor.isConnected) close();
  }, 1000);

  function close(): void {
    clearTimeout(arming);
    clearInterval(watch);
    window.removeEventListener('app-route-changed', onRoute);
    document.removeEventListener('click', onOutside);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onScroll);
    panel.remove();
    if (open?.panel === panel) open = null;
  }
  open = { panel, close };

  panel.querySelector<HTMLButtonElement>('button')?.focus();

  void emojiListFor(options.viewer, options.relays).then(
    (emoji: CustomEmoji[]): void => {
      if (!panel.isConnected) return;
      const custom = panel.querySelector('.nox-emoji-custom');
      if (!custom) return;
      if (emoji.length === 0) {
        custom.innerHTML =
          '<p class="nox-emoji-note">No custom emoji yet. Emoji lists you make in other apps show up here.</p>';
        place();
        return;
      }
      const grid: string = emoji
        .map(
          (item: CustomEmoji): string =>
            `<button type="button" class="nox-emoji-choice" data-shortcode="${escapeHtml(item.shortcode)}" data-url="${escapeHtml(item.url)}" aria-label=":${escapeHtml(item.shortcode)}:" title=":${escapeHtml(item.shortcode)}:"><img class="nox-emoji" src="${escapeHtml(item.url)}" alt=":${escapeHtml(item.shortcode)}:" loading="lazy" decoding="async" /></button>`,
        )
        .join('');
      custom.innerHTML = `${
        emoji.length > FILTER_FROM
          ? '<input type="search" class="nox-input nox-emoji-filter" placeholder="Filter" aria-label="Filter emoji" />'
          : ''
      }<div class="nox-emoji-grid">${grid}</div>`;
      const filter =
        custom.querySelector<HTMLInputElement>('.nox-emoji-filter');
      filter?.addEventListener('input', (): void => {
        const query: string = filter.value.trim().toLowerCase();
        for (const button of custom.querySelectorAll<HTMLButtonElement>(
          '.nox-emoji-grid button',
        )) {
          button.hidden = !(button.dataset.shortcode ?? '')
            .toLowerCase()
            .includes(query);
        }
      });
      place();
    },
  );
}
