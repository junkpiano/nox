/**
 * Changing your own profile.
 *
 * It starts from your newest profile on every relay, not from the cache: a
 * kind 0 replaces the whole profile, so an edit made on top of a stale copy
 * would quietly undo whatever you changed elsewhere since. When that copy
 * cannot be read, saving is off rather than a guess.
 *
 * The preview at the top is how other people will see you, as you type.
 */

import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  type KeyboardTypeOptions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getSession } from '../../src/common/session';
import {
  EDITABLE_PROFILE_FIELDS,
  type EditableProfileField,
  type OwnMetadata,
  type ProfileEdits,
} from '../../src/features/profile/profile-metadata';
import type { PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import { pictureUrl } from '../lib/avatar';
import {
  loadOwnMetadata,
  NotAcceptedError,
  saveOwnMetadata,
} from '../lib/profile-edit';

type Values = Record<EditableProfileField, string>;

interface FieldSpec {
  field: EditableProfileField;
  label: string;
  placeholder?: string;
  keyboard?: KeyboardTypeOptions;
  multiline?: boolean;
}

const GROUPS: ReadonlyArray<{ title: string; fields: FieldSpec[] }> = [
  {
    title: 'About you',
    fields: [
      { field: 'display_name', label: 'Display name' },
      { field: 'name', label: 'Username' },
      { field: 'about', label: 'About', multiline: true },
    ],
  },
  {
    title: 'Pictures',
    fields: [
      { field: 'picture', label: 'Picture URL', keyboard: 'url' },
      { field: 'banner', label: 'Banner URL', keyboard: 'url' },
    ],
  },
  {
    title: 'Links',
    fields: [
      { field: 'website', label: 'Website', keyboard: 'url' },
      {
        field: 'nip05',
        label: 'NIP-05',
        placeholder: 'you@example.com',
        keyboard: 'email-address',
      },
      {
        field: 'lud16',
        label: 'Lightning address',
        placeholder: 'you@wallet.example',
        keyboard: 'email-address',
      },
    ],
  },
];

function valuesOf(base: OwnMetadata): Values {
  const values = {} as Values;
  for (const field of EDITABLE_PROFILE_FIELDS) {
    const raw: unknown = base.content[field];
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

/** Only what changed, so an untouched field is left exactly as it was. */
function changesOf(from: Values, to: Values): ProfileEdits {
  const edits: ProfileEdits = {};
  for (const field of EDITABLE_PROFILE_FIELDS) {
    if (from[field] !== to[field]) edits[field] = to[field];
  }
  return edits;
}

export default function EditProfile({
  navigation,
}: {
  navigation: NativeStackNavigationProp<RootStackParamList>;
}) {
  const viewer: PubkeyHex | null = getSession().pubkey as PubkeyHex | null;
  const [base, setBase] = useState<OwnMetadata | null>(null);
  const [loaded, setLoaded] = useState<Values | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  // Two taps can land before `saving` re-renders the button disabled.
  const inFlight = useRef(false);

  const load = useCallback((): void => {
    if (!viewer) return;
    setFailed(false);
    setBase(null);
    loadOwnMetadata(viewer)
      .then((own: OwnMetadata): void => {
        const initial: Values = valuesOf(own);
        setBase(own);
        setLoaded(initial);
        setValues(initial);
      })
      .catch((): void => setFailed(true));
  }, [viewer]);

  useEffect((): void => load(), [load]);

  const save = useCallback(async (): Promise<void> => {
    if (!viewer || !base || !loaded || !values) return;
    const edits: ProfileEdits = changesOf(loaded, values);
    if (Object.keys(edits).length === 0) {
      navigation.goBack();
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await saveOwnMetadata(viewer, base, edits);
      navigation.goBack();
    } catch (error: unknown) {
      Alert.alert(
        'Not saved',
        error instanceof NotAcceptedError
          ? 'No relay accepted your profile. Your changes are still here.'
          : String((error as Error)?.message ?? error),
      );
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [viewer, base, loaded, values, navigation]);

  const canSave: boolean = Boolean(base && values) && !saving;

  useLayoutEffect((): void => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={(): void => void save()}
          disabled={!canSave}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave, busy: saving }}
        >
          <Text style={canSave ? styles.save : styles.saveOff}>
            {saving ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
      ),
    });
  }, [navigation, save, canSave, saving]);

  if (!viewer) {
    return (
      <View style={styles.centre}>
        <Text style={styles.message}>Sign in to edit your profile.</Text>
      </View>
    );
  }

  if (failed) {
    return (
      <View style={styles.centre}>
        <Text style={styles.message}>
          Couldn't read your current profile from all of your relays. Saving now
          could erase it. Try again, or remove a relay that no longer answers in
          Settings → Relays.
        </Text>
        <Pressable
          onPress={load}
          style={styles.retry}
          accessibilityRole="button"
        >
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!values) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color="#89a8ff" />
      </View>
    );
  }

  const picture: string | null = pictureUrl(values.picture);
  const shownName: string = values.display_name.trim() || values.name.trim();

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.preview}>
        {picture ? (
          <Image source={{ uri: picture }} style={styles.avatar} />
        ) : (
          <View style={styles.avatar} />
        )}
        <View style={styles.previewText}>
          <Text
            style={shownName ? styles.previewName : styles.previewNoName}
            numberOfLines={1}
          >
            {shownName || 'No name yet'}
          </Text>
          {values.nip05.trim() ? (
            <Text style={styles.previewNip05} numberOfLines={1}>
              {values.nip05.trim()}
            </Text>
          ) : null}
        </View>
      </View>

      {GROUPS.map((group) => (
        <View key={group.title} style={styles.group}>
          <Text style={styles.section}>{group.title}</Text>
          {group.fields.map((spec: FieldSpec) => (
            <View key={spec.field} style={styles.field}>
              <Text style={styles.label}>{spec.label}</Text>
              <TextInput
                value={values[spec.field]}
                onChangeText={(text: string): void =>
                  setValues((previous: Values | null): Values | null =>
                    previous ? { ...previous, [spec.field]: text } : previous,
                  )
                }
                editable={!saving}
                placeholder={spec.placeholder}
                placeholderTextColor="#5b6b88"
                multiline={spec.multiline ?? false}
                keyboardType={spec.keyboard ?? 'default'}
                autoCapitalize={spec.keyboard ? 'none' : 'sentences'}
                autoCorrect={!spec.keyboard}
                accessibilityLabel={spec.label}
                style={[styles.input, spec.multiline && styles.multiline]}
              />
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  content: { paddingBottom: 48 },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
    backgroundColor: '#0b1220',
  },
  message: {
    color: '#b9c6de',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  retry: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: { color: '#0b1220', fontWeight: '700', fontSize: 14 },
  save: { color: '#89a8ff', fontWeight: '700', fontSize: 16 },
  saveOff: { color: '#5b6b88', fontWeight: '700', fontSize: 16 },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148,163,184,0.14)',
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#25406e',
  },
  previewText: { flex: 1 },
  previewName: { color: '#e8eeff', fontSize: 18, fontWeight: '700' },
  previewNoName: { color: '#5b6b88', fontSize: 18, fontWeight: '700' },
  previewNip05: { color: '#5b6b88', fontSize: 12, marginTop: 2 },
  group: { paddingHorizontal: 16 },
  section: {
    color: '#8ea0c0',
    fontSize: 13,
    fontWeight: '700',
    paddingTop: 20,
    paddingBottom: 8,
  },
  field: { marginBottom: 14 },
  label: {
    color: '#b9c6de',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e8eeff',
    fontSize: 15,
    backgroundColor: '#101a2e',
  },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
});
