/**
 * A card for a web link in a post.
 *
 * The web app has shown these since it was written: the page's title, a
 * line of its description, its picture and the name of the site, fetched
 * from the page's Open Graph tags. The phone showed the bare URL. The page
 * is read through the proxy, the way a browser tab reads it, and not by
 * the phone itself: a request from the reader's own device is one a post
 * could aim at the reader's own network. What the card says is decided by
 * the shared describer, so this card and the web's agree about the same
 * page.
 *
 * Nothing is drawn until the page has answered, and nothing at all when it
 * had nothing to say: the URL is still in the text, and a box saying only
 * the host would repeat it.
 */

import { useEffect, useState } from 'react';
import {
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  type LinkCard as Card,
  describeLink,
} from '../../src/common/link-card';
import { fetchOGP } from '../../src/common/ogp-fetch';

export default function LinkCard({ url }: { url: string }) {
  const [card, setCard] = useState<Card | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect((): (() => void) => {
    let cancelled = false;
    setCard(null);
    setImageFailed(false);
    void fetchOGP(url)
      .then((ogp): void => {
        if (cancelled || !ogp) return;
        setCard(describeLink(ogp));
      })
      .catch((): void => {});
    return (): void => {
      cancelled = true;
    };
  }, [url]);

  if (!card) return null;

  return (
    <Pressable
      onPress={(): void => {
        void Linking.openURL(card.url);
      }}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      accessibilityRole="link"
    >
      {card.image && !imageFailed ? (
        <Image
          source={{ uri: card.image }}
          style={styles.image}
          resizeMode="cover"
          onError={(): void => setImageFailed(true)}
        />
      ) : null}
      <View style={styles.body}>
        <Text style={styles.site} numberOfLines={1}>
          {card.site}
        </Text>
        <Text style={styles.title} numberOfLines={2}>
          {card.title}
        </Text>
        {card.description ? (
          <Text style={styles.description} numberOfLines={2}>
            {card.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 12,
    backgroundColor: '#101a2e',
    overflow: 'hidden',
  },
  cardPressed: { backgroundColor: '#16233f' },
  image: { width: '100%', height: 160, backgroundColor: '#16233f' },
  body: { paddingHorizontal: 12, paddingVertical: 10, gap: 3 },
  site: { color: '#5b6b88', fontSize: 11 },
  title: { color: '#e8eeff', fontSize: 14, fontWeight: '700', lineHeight: 19 },
  description: { color: '#8ea0c0', fontSize: 12, lineHeight: 17 },
});
