/**
 * Reading a warning the author put on their own post.
 *
 * NIP-36 is one of the few things on Nostr where somebody has said, in
 * advance, "do not show this to people who have not asked for it". Ignoring it
 * is not a rendering shortcut; it is overriding a decision the author made
 * about their own post, in front of a reader who was given no say.
 *
 * Split out of `event-render.ts` so both front ends read the tag the same way.
 * The web has honoured this all along; the native app did not, and showed
 * every warned post immediately.
 *
 * Three spellings are accepted because three are in use:
 *
 *   ["content-warning", <reason?>]        the NIP-36 tag
 *   ["cw", <reason?>]                     a common shorthand
 *   ["L", "content-warning"] with
 *   ["l", <reason>, "content-warning"]    NIP-32 labels in that namespace
 *
 * Reading only the first would leave posts warned by other clients uncovered,
 * and the cost of being generous here is nothing.
 */

import type { NostrEvent } from '../../types/nostr';

export interface ContentWarning {
  hasWarning: boolean;
  /** The author's own words, when they gave any. Never invented. */
  reason: string;
}

function isContentWarningNamespace(value: string | undefined): boolean {
  return (value || '').trim().toLowerCase() === 'content-warning';
}

export function getContentWarning(event: NostrEvent): ContentWarning {
  let hasContentWarningTag = false;
  let hasContentWarningNamespace = false;
  let hasScopedWarningLabel = false;
  let reason = '';

  for (const tag of event.tags) {
    const tagName: string = (tag[0] || '').trim();
    if (!tagName) {
      continue;
    }

    if (tagName.toLowerCase() === 'content-warning' || tagName === 'cw') {
      hasContentWarningTag = true;
      const tagReason: string = (tag[1] || '').trim();
      if (!reason && tagReason) {
        reason = tagReason;
      }
      continue;
    }

    if (tagName === 'L' && isContentWarningNamespace(tag[1])) {
      hasContentWarningNamespace = true;
      continue;
    }

    if (tagName === 'l' && isContentWarningNamespace(tag[2])) {
      hasScopedWarningLabel = true;
      const labelReason: string = (tag[1] || '').trim();
      if (!reason && labelReason) {
        reason = labelReason;
      }
    }
  }

  return {
    hasWarning:
      hasContentWarningTag ||
      hasContentWarningNamespace ||
      hasScopedWarningLabel,
    reason,
  };
}

/** The longest reason worth showing on the covering line. */
const MAX_REASON_LENGTH = 80;

/**
 * The line shown in place of the post.
 *
 * The reason is a string its author chose, so it is flattened to one line and
 * capped for the same reasons a display name is. A newline here would let a
 * warning label push the post it is hiding back into view.
 */
export function contentWarningSummary(warning: ContentWarning): string {
  if (!warning.reason) {
    return 'Content warning';
  }
  const oneLine = warning.reason
    // biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing them is the point
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_LENGTH);
  return oneLine ? `Content warning: ${oneLine}` : 'Content warning';
}
