/**
 * What the heart button shows: the reaction one tap sends.
 *
 * ❤ - the default - keeps the ♡ / ♥ it always had. A chosen emoji or custom
 * picture takes its place, quiet until given and in full once it is: the
 * same two states the heart has.
 */

import { Image, StyleSheet, Text } from 'react-native';
import { DEFAULT_QUICK_REACTION } from '../../src/common/quick-reaction';
import type { ReactionAggregate } from '../../src/common/reaction-interactions';

export default function QuickReactionGlyph({
  reaction,
  given,
  style,
}: {
  reaction: ReactionAggregate;
  given: boolean;
  style: object;
}) {
  if (reaction.key === DEFAULT_QUICK_REACTION.key) {
    return <Text style={style}>{given ? '♥' : '♡'}</Text>;
  }
  if (reaction.imageUrl) {
    return (
      <Image
        source={{ uri: reaction.imageUrl }}
        style={[styles.picture, !given && styles.quiet]}
        accessibilityLabel={reaction.content}
      />
    );
  }
  return (
    <Text style={[style, styles.emoji, !given && styles.quiet]}>
      {reaction.content}
    </Text>
  );
}

const styles = StyleSheet.create({
  picture: { width: 20, height: 20, resizeMode: 'contain' },
  emoji: { fontSize: 18 },
  quiet: { opacity: 0.5 },
});
