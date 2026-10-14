/**
 * The quick reaction itself, as Settings shows it: the emoji, the custom
 * picture, or ♥ for the default. The heart button on a post stays a heart.
 */

import { Image, StyleSheet, Text } from 'react-native';
import { DEFAULT_QUICK_REACTION } from '../../src/common/quick-reaction';
import type { ReactionAggregate } from '../../src/common/reaction-interactions';

export default function QuickReactionGlyph({
  reaction,
  style,
}: {
  reaction: ReactionAggregate;
  style: object;
}) {
  if (reaction.key === DEFAULT_QUICK_REACTION.key) {
    return <Text style={style}>{'\u2665\uFE0E'}</Text>;
  }
  if (reaction.imageUrl) {
    return (
      <Image
        source={{ uri: reaction.imageUrl }}
        style={styles.picture}
        accessibilityLabel={reaction.content}
      />
    );
  }
  return <Text style={[style, styles.emoji]}>{reaction.content}</Text>;
}

const styles = StyleSheet.create({
  picture: { width: 20, height: 20, resizeMode: 'contain' },
  emoji: { fontSize: 18 },
});
