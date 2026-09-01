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

import { useState } from 'react';
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

import ImageViewer from './ImageViewer';
import QuoteCard from './QuoteCard';
import RichText from './RichText';

export interface PostBodyProps {
  content: string;
  textStyle?: object;
  linkStyle?: object;
  numberOfLines?: number;
  /**
   * Opens the post. Only the words carry it: a picture opens itself, and the
   * links inside the words open themselves, so this is what is left over.
   */
  onPressText?: () => void;
}

export default function PostBody({
  content,
  textStyle,
  linkStyle,
  numberOfLines,
  onPressText,
}: PostBodyProps) {
  const { segments, media, quotes }: PartitionedContent =
    partitionContent(content);
  const [opened, setOpened] = useState<number | null>(null);
  const pictures: string[] = media
    .filter((item) => item.kind === 'image')
    .map((item) => item.url);
  const prose: string = segments
    .map((segment): string => segment.text)
    .join('')
    .trim();

  return (
    <View>
      {prose.length > 0 ? (
        <Pressable onPress={onPressText} disabled={!onPressText}>
          <RichText
            content={prose}
            style={textStyle}
            linkStyle={linkStyle}
            numberOfLines={numberOfLines}
          />
        </Pressable>
      ) : null}

      {media.map((item) =>
        item.kind === 'image' ? (
          <Pressable
            key={item.url}
            onPress={(): void => setOpened(pictures.indexOf(item.url))}
          >
            <Image
              source={{ uri: item.url }}
              style={styles.image}
              resizeMode="cover"
            />
          </Pressable>
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

      {/* Two at most. A post quoting five notes is a list, and a list of
          full cards buries whatever the author actually wrote. */}
      {quotes.slice(0, 2).map((quote) => (
        <QuoteCard key={quote.id} eventId={quote.id} relays={quote.relays} />
      ))}

      <ImageViewer
        urls={pictures}
        index={opened}
        onClose={(): void => setOpened(null)}
      />
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
