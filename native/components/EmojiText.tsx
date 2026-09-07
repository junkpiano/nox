/**
 * A name, with the pictures its author put in it.
 *
 * NIP-30 lets a kind 0 carry `:shortcode:` in a name and a picture for each.
 * A name is not a post: it has no links to follow and nobody to mention, so
 * this draws only the two things a name can be - words and emoji - and
 * leaves everything else as the text it is. `RichText` is for a body.
 */

import {
  Image,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
} from 'react-native';
import {
  type ContentSegment,
  type EmojiMap,
  parseEmojiSegments,
} from '../../src/common/content-segments';

/** An inline picture the height of the line, give or take. */
function emojiSize(style: StyleProp<TextStyle>): number {
  const fontSize: number = StyleSheet.flatten(style)?.fontSize ?? 14;
  return Math.round(fontSize * 1.15);
}

export default function EmojiText({
  text,
  emoji,
  style,
  numberOfLines,
  onPress,
}: {
  text: string;
  emoji?: EmojiMap | undefined;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  onPress?: (() => void) | undefined;
}) {
  // Nothing to look up, nothing to parse: the overwhelming majority of names.
  if (!emoji || emoji.size === 0) {
    return (
      <Text style={style} numberOfLines={numberOfLines} onPress={onPress}>
        {text}
      </Text>
    );
  }

  const segments: ContentSegment[] = parseEmojiSegments(text, emoji);
  const size: number = emojiSize(style);

  return (
    <Text style={style} numberOfLines={numberOfLines} onPress={onPress}>
      {segments.map((segment: ContentSegment, index: number) =>
        segment.kind === 'emoji' ? (
          <Image
            key={`${index}-${segment.shortcode}`}
            source={{ uri: segment.url }}
            style={{ width: size, height: size }}
            accessibilityLabel={segment.shortcode}
          />
        ) : (
          <Text key={`${index}-${segment.kind}`}>{segment.text}</Text>
        ),
      )}
    </Text>
  );
}
