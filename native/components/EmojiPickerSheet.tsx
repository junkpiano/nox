/**
 * Choosing a reaction on the phone: the same choices the web offers.
 *
 * A sheet from the bottom, the way the post menu opens. One search box finds
 * custom emoji by shortcode and standard ones by any of their names; with
 * nothing typed, the quick row and the person's own emoji come first. The
 * standard set is 1,500 emoji, so it is a virtualised grid: only the rows
 * on screen are drawn.
 */

import emojiDictionary from 'emoji-dictionary';
import { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { loadableImageUrl } from '../../src/common/avatar';
import { type CustomEmoji, fetchEmojiList } from '../../src/common/emoji-list';
import {
  getReactionAggregate,
  type ReactionAggregate,
} from '../../src/common/reaction-interactions';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';

const COMMON: string[] = ['👍', '😂', '🔥', '🎉', '🙏', '👀', '💯', '😢'];
const COLUMNS: number = 8;
/** Pictures load over https, like every other image the phone draws. */
const PHONE_IMAGES = { secureOnly: true } as const;

interface Standard {
  emoji: string;
  /** Every name it answers to, with and without underscores. */
  names: string;
}

let standard: Standard[] | null = null;
function standardEmoji(): Standard[] {
  if (standard) return standard;
  const byEmoji: Map<string, string[]> = new Map();
  for (const name of emojiDictionary.names as string[]) {
    const emoji: string | undefined = emojiDictionary.getUnicode(name);
    if (!emoji) continue;
    byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), name]);
  }
  standard = Array.from(byEmoji, ([emoji, names]) => {
    const joined: string = names.join(' ');
    return { emoji, names: `${joined} ${joined.replace(/_/g, ' ')}` };
  });
  return standard;
}

/** A match starts a word: "cat" finds smiley_cat, not multiplication. */
function matches(text: string, query: string): boolean {
  return ` ${text} ${text.replace(/[_-]/g, ' ')}`
    .toLowerCase()
    .includes(` ${query}`);
}

// ponytail: per-session memory memo of the emoji list, as on the web; store
// it if fetching once per session ever shows up as slow.
const lists: Map<PubkeyHex, Promise<CustomEmoji[]>> = new Map();

/** After adding to the list: the next sheet reads it afresh. */
export function forgetEmojiList(viewer: PubkeyHex): void {
  lists.delete(viewer);
}

function emojiListFor(viewer: PubkeyHex): Promise<CustomEmoji[]> {
  let list: Promise<CustomEmoji[]> | undefined = lists.get(viewer);
  if (!list) {
    list = fetchEmojiList(viewer, getRelays()).catch((): CustomEmoji[] => {
      lists.delete(viewer);
      return [];
    });
    lists.set(viewer, list);
  }
  return list;
}

export interface EmojiPickerSheetProps {
  visible: boolean;
  viewer: PubkeyHex | null;
  onClose: () => void;
  onPick: (reaction: ReactionAggregate) => void;
}

export default function EmojiPickerSheet({
  visible,
  viewer,
  onClose,
  onPick,
}: EmojiPickerSheetProps) {
  const [query, setQuery] = useState('');
  const [mine, setMine] = useState<CustomEmoji[] | null>(null);

  useEffect((): (() => void) | undefined => {
    if (!visible || !viewer) return undefined;
    let live: boolean = true;
    void emojiListFor(viewer).then((list: CustomEmoji[]): void => {
      if (live) setMine(list);
    });
    return (): void => {
      live = false;
    };
  }, [visible, viewer]);

  const q: string = query.trim().toLowerCase();
  const custom: CustomEmoji[] = useMemo(
    (): CustomEmoji[] =>
      (mine ?? [])
        .filter((item) => loadableImageUrl(item.url, PHONE_IMAGES))
        .filter((item) => !q || matches(item.shortcode, q)),
    [mine, q],
  );
  const all: Standard[] = useMemo(
    (): Standard[] =>
      q
        ? standardEmoji().filter((item) => matches(item.names, q))
        : standardEmoji(),
    [q],
  );

  // Built by the same reader the badges use, so the new reaction joins its
  // badge rather than starting one of its own.
  const choose = (reaction: ReactionAggregate): void => {
    setQuery('');
    onClose();
    onPick(reaction);
  };

  const header = (
    <View>
      {q ? null : (
        <View style={styles.grid}>
          {COMMON.map((emoji: string) => (
            <Pressable
              key={emoji}
              accessibilityLabel={emoji}
              onPress={(): void => choose(getReactionAggregate(emoji, []))}
              style={styles.cell}
            >
              <Text style={styles.emoji}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {mine === null ? (
        <Text style={styles.note}>Loading your emoji…</Text>
      ) : custom.length > 0 ? (
        <>
          <Text style={styles.heading}>Yours</Text>
          <View style={styles.grid}>
            {custom.map((item: CustomEmoji) => (
              <Pressable
                key={item.shortcode}
                accessibilityLabel={`:${item.shortcode}:`}
                onPress={(): void =>
                  choose(
                    getReactionAggregate(`:${item.shortcode}:`, [
                      ['emoji', item.shortcode, item.url],
                    ]),
                  )
                }
                style={styles.cell}
              >
                <Image source={{ uri: item.url }} style={styles.picture} />
              </Pressable>
            ))}
          </View>
        </>
      ) : q ? null : (
        <Text style={styles.note}>
          You have no custom emoji yet. Add emoji sets in an app like emojito,
          and they’ll appear here.
        </Text>
      )}
      {all.length > 0 ? <Text style={styles.heading}>All emoji</Text> : null}
    </View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search emoji"
          placeholderTextColor="#5b6b88"
          autoCorrect={false}
          autoCapitalize="none"
          style={styles.search}
        />
        <FlatList
          data={all}
          keyExtractor={(item: Standard): string => item.emoji}
          numColumns={COLUMNS}
          ListHeaderComponent={header}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={64}
          renderItem={({ item }: { item: Standard }) => (
            <Pressable
              accessibilityLabel={item.names.split(' ')[0]}
              onPress={(): void => choose(getReactionAggregate(item.emoji, []))}
              style={styles.cell}
            >
              <Text style={styles.emoji}>{item.emoji}</Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  sheet: {
    height: '60%',
    paddingTop: 12,
    paddingHorizontal: 12,
    backgroundColor: '#111a33',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  search: {
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#25406e',
    color: '#edf3ff',
    fontSize: 15,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / COLUMNS}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 24 },
  picture: { width: 28, height: 28, resizeMode: 'contain' },
  heading: {
    marginTop: 10,
    marginBottom: 4,
    color: '#7283aa',
    fontSize: 12,
    fontWeight: '600',
  },
  note: { paddingVertical: 8, color: '#7283aa', fontSize: 13 },
});
