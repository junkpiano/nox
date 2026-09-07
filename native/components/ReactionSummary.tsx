/**
 * Who reacted to a post, counted.
 *
 * A row of small badges: the symbol and how many people pressed it,
 * commonest first. A custom emoji brings its own picture. Nothing here is
 * tappable - reacting is the ♡ in the action row, and a badge that both
 * reported and acted would be two meanings on one control.
 *
 * The judgement is shared (`reaction-summary.ts`) and the asking is a book
 * shared by every screen (`use-reaction-summaries.ts`); this draws what
 * they know.
 */

import { Image, StyleSheet, Text, View } from 'react-native';
import { loadableImageUrl } from '../../src/common/avatar';
import type { ReactionAggregate } from '../../src/common/reaction-interactions';
import { REACTION_SUMMARY_LIMIT } from '../../src/common/reaction-summary';

/**
 * The most a symbol may be.
 *
 * A reaction's content is whatever a stranger signed: usually one emoji,
 * but nothing stops a paragraph, and a badge is not a place to read one.
 */
const MAX_SYMBOL_CHARS: number = 12;

/** Pictures load over https, like every other image the phone draws. */
const PHONE_IMAGES = { secureOnly: true } as const;

/**
 * What to draw for a symbol.
 *
 * NIP-25 defines "+" as a like and "-" as a dislike, and a reader shown a
 * literal "+" learns nothing. The event keeps what its author wrote; only
 * the badge speaks in symbols people read.
 */
function symbolFor(content: string): string {
  if (content === '+') return '♥';
  if (content === '-') return '👎';
  // Cut to what a badge can hold, on one line: the rest is not a symbol.
  const oneLine: string = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_SYMBOL_CHARS
    ? `${oneLine.slice(0, MAX_SYMBOL_CHARS)}…`
    : oneLine;
}

export default function ReactionSummary({
  entries,
  compact = false,
}: {
  entries: ReactionAggregate[] | undefined;
  /** In a timeline row, where the badges sit inside the card's own padding. */
  compact?: boolean;
}) {
  if (!entries || entries.length === 0) return null;

  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      {entries
        .slice(0, REACTION_SUMMARY_LIMIT)
        .map((entry: ReactionAggregate) => {
          // A picture the author supplied is drawn only if it is one the
          // phone will load; otherwise the shortcode stands in for it,
          // which is better than an empty box.
          const picture: string | null = entry.imageUrl
            ? loadableImageUrl(entry.imageUrl, PHONE_IMAGES)
            : null;
          return (
            <View key={entry.key} style={styles.badge}>
              {picture ? (
                <Image
                  source={{ uri: picture }}
                  style={styles.emojiImage}
                  accessibilityLabel={entry.shortcode ?? ''}
                />
              ) : (
                <Text style={styles.emoji} numberOfLines={1}>
                  {symbolFor(
                    entry.shortcode ? `:${entry.shortcode}:` : entry.content,
                  )}
                </Text>
              )}
              <Text style={styles.count}>{entry.count}</Text>
            </View>
          );
        })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  rowCompact: { paddingHorizontal: 0, paddingTop: 8 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.18)',
    borderRadius: 999,
    backgroundColor: '#101a2e',
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  emoji: { fontSize: 13, color: '#e8eeff', maxWidth: 140 },
  emojiImage: { width: 16, height: 16 },
  count: { fontSize: 12, color: '#8ea0c0', fontWeight: '700' },
});
