/**
 * The relay list.
 *
 * All of the logic here is shared with the web app: `getRelays`, `setRelays`
 * and `normalizeRelayUrl` come from features/relays/relays.ts, which now reads
 * and writes through the kv seam. Adding a relay on the phone and adding one
 * in the browser go through exactly the same normalisation and the same
 * deduplication.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { onAppEvent } from '../../src/common/app-events';
import {
  getRelays,
  normalizeRelayUrl,
  setRelays,
} from '../../src/features/relays/relays';

export default function Relays() {
  const [relays, setLocalRelays] = useState<string[]>(getRelays);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The shared module announces its own changes, so the screen follows them
  // rather than assuming it is the only thing that can edit the list.
  useEffect(() => {
    return onAppEvent('relays-updated', () => {
      setLocalRelays([...getRelays()]);
    });
  }, []);

  const add = useCallback((): void => {
    const normalized: string | null = normalizeRelayUrl(draft);
    if (!normalized) {
      setError('That is not a relay address. Try wss://relay.example.com');
      return;
    }
    if (getRelays().includes(normalized)) {
      setError('That relay is already on the list.');
      return;
    }
    setRelays([...getRelays(), normalized]);
    setDraft('');
    setError(null);
  }, [draft]);

  const remove = useCallback((relayUrl: string): void => {
    const remaining: string[] = getRelays().filter(
      (candidate: string): boolean => candidate !== relayUrl,
    );
    if (remaining.length === 0) {
      // An empty list is not a configuration, it is an app that cannot work.
      Alert.alert(
        'Keep at least one relay',
        'With no relays there is nowhere to read from or publish to.',
      );
      return;
    }
    setRelays(remaining);
  }, []);

  return (
    <View style={styles.screen}>
      <View style={styles.adder}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="wss://relay.example.com"
          placeholderTextColor="#5b6b88"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          onSubmitEditing={add}
        />
        <Pressable onPress={add} style={styles.addButton}>
          <Text style={styles.addButtonText}>Add</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={relays}
        keyExtractor={(url: string) => url}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        renderItem={({ item }: { item: string }) => (
          <View style={styles.row}>
            <Text style={styles.url} numberOfLines={1}>
              {item}
            </Text>
            <Pressable onPress={() => remove(item)} hitSlop={8}>
              <Text style={styles.remove}>Remove</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  adder: { flexDirection: 'row', gap: 8, padding: 16 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e8eeff',
    fontSize: 13,
    backgroundColor: '#101a2e',
  },
  addButton: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  addButtonText: { color: '#0b1220', fontWeight: '700', fontSize: 14 },
  error: { color: '#ff9a9a', fontSize: 12, paddingHorizontal: 16, paddingBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  url: { color: '#b9c6de', fontSize: 13, flex: 1 },
  remove: { color: '#ff9a9a', fontSize: 13 },
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
});
