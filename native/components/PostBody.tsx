/**
 * A post: its words, and then its pictures.
 *
 * The two have to be separated before rendering because a `<Text>` cannot hold
 * an `<Image>` on this platform. Without that separation the phone showed a
 * forty-character URL in the middle of a sentence where the web app shows the
 * picture, which is most of what made a timeline here look unfinished.
 *
 * Video is a link rather than a player. Playing it needs a native module this
 * app does not carry yet, and a poster frame with a play button that opens
 * somewhere else pretends to be a player; a labelled link does not.
 */

import {
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { PartitionedContent } from '../../src/common/content-segments';
import { partitionContent } from '../../src/common/content-segments';
import RichText from './RichText';

export interface PostBodyProps {
  content: string;
  textStyle?: object;
  linkStyle?: object;
  numberOfLines?: number;
}

export default function PostBody({
  content,
  textStyle,
  linkStyle,
  numberOfLines,
}: PostBodyProps) {
  const { segments, media }: PartitionedContent = partitionContent(content);
  const prose: string = segments
    .map((segment): string => segment.text)
    .join('')
    .trim();

  return (
    <View>
      {prose.length > 0 ? (
        <RichText
          content={prose}
          style={textStyle}
          linkStyle={linkStyle}
          numberOfLines={numberOfLines}
        />
      ) : null}

      {media.map((item) =>
        item.kind === 'image' ? (
          <Image
            key={item.url}
            source={{ uri: item.url }}
            style={styles.image}
            resizeMode="cover"
          />
        ) : (
          <Pressable
            key={item.url}
            onPress={(): void => {
              void Linking.openURL(item.url);
            }}
            style={styles.video}
          >
            <Text style={styles.videoText}>▶ Video</Text>
            <Text style={styles.videoHost} numberOfLines={1}>
              {item.url.replace(/^https?:\/\//, '')}
            </Text>
          </Pressable>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    width: '100%',
    height: 220,
    borderRadius: 12,
    marginTop: 8,
    backgroundColor: '#16233f',
  },
  video: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#101a2e',
    gap: 3,
  },
  videoText: { color: '#89a8ff', fontSize: 14, fontWeight: '700' },
  videoHost: { color: '#5b6b88', fontSize: 11 },
});
