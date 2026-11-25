# Edit profile (phone app): plan

How [spec.md](spec.md) is built. Three tasks, each small enough for one
session of a local model in OpenCode; each is handed over as its own section
of this file. Tasks run in order: 2 imports what 1 creates, 3 connects 2.

| Task | Files | Finish line |
|---|---|---|
| 1. Shared helper | new `src/features/profile/profile-metadata.ts` | `tests/profile-metadata.test.ts` (PROFILE-EDIT-1 to 6) |
| 2. Screen | new `native/lib/profile-edit.ts`, `native/screens/EditProfile.tsx` | native `tsc`, biome |
| 3. Wiring | `src/common/app-events.ts`, `native/App.tsx`, `native/screens/Profile.tsx` | native `tsc`, biome, `npm test` (PROFILE-EDIT-7, 8) |

The web editor (`src/features/profile/profile.ts`) is not changed here; see
the spec's Not doing.

Outcome: Task 1 was done by a local model (nemotron) and passed its tests as
written. Tasks 2 and 3 were written directly. Review then tightened the read
to refuse when any relay is silent (PROFILE-EDIT-5) and made the profile
screen take the published profile instead of re-reading it
(PROFILE-EDIT-8); the code differs from the task text below in those
places.

## Task 1: create `src/features/profile/profile-metadata.ts`

Work in the current directory (a git worktree of the nox repo).
Create this ONE new file: `src/features/profile/profile-metadata.ts`.
Do not edit any other file. In particular do not edit the test file.

The test `tests/profile-metadata.test.ts` already exists and defines what the
file must do. Read it first. The spec is `docs/features/edit-profile/spec.md`.

### What the file exports

```ts
import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { newestOf, queryRelaysDetailed, NoRelayAnsweredError } from '../../common/relay-query.js';

export const EDITABLE_PROFILE_FIELDS = [
  'display_name', 'name', 'about', 'picture', 'banner', 'website', 'nip05', 'lud16',
] as const;
export type EditableProfileField = (typeof EDITABLE_PROFILE_FIELDS)[number];
export type ProfileEdits = Partial<Record<EditableProfileField, string>>;

export interface OwnMetadata {
  /** The newest kind 0's content, every key kept, known or not. */
  content: Record<string, unknown>;
  /** That event's tags, unchanged. */
  tags: string[][];
  /** That event's created_at, or null when there was none. */
  createdAt: number | null;
}

export class UnreadableMetadataError extends Error { /* name = 'UnreadableMetadataError' */ }

export async function readOwnMetadata(relays: string[], pubkey: PubkeyHex): Promise<OwnMetadata>
export function applyProfileEdits(content: Record<string, unknown>, edits: ProfileEdits): Record<string, unknown>
export function profileMetadataDraft(
  pubkey: PubkeyHex,
  content: Record<string, unknown>,
  tags: string[][],
  previousCreatedAt: number | null,
  now: number = Math.floor(Date.now() / 1000),
): Omit<NostrEvent, 'id' | 'sig'>
```

### Rules for each function

`readOwnMetadata`:
1. `const result = await queryRelaysDetailed(relays, { kinds: [0], authors: [pubkey] }, undefined, { everyRelay: true });`
2. If `result.answered === 0`, throw `new NoRelayAnsweredError(relays)`.
3. `const newest = newestOf(result.events.filter(e => e.kind === 0 && e.pubkey === pubkey));`
4. No newest: return `{ content: {}, tags: [], createdAt: null }`.
5. `JSON.parse(newest.content)` inside try/catch. If it throws, or the result is
   not a plain object (null, an array, a string or a number), throw
   `new UnreadableMetadataError('Your current profile could not be read')`.
6. Return `{ content: parsed, tags: newest.tags.map(t => [...t]), createdAt: newest.created_at }`.

`applyProfileEdits`:
1. Start from a shallow copy: `const next = { ...content };` never change `content`.
2. For each field of `EDITABLE_PROFILE_FIELDS` that is a key of `edits`
   (`field in edits`): trim the value; if the result is empty, `delete next[field]`,
   else `next[field] = trimmed`.
3. Fields not in `edits` are left exactly as they are.
4. If `'website' in edits`: when `next.website` is set, `next.url = next.website`;
   otherwise `delete next.url`.
5. Return `next`.

`profileMetadataDraft`:
1. `created_at` is `now`, but if `previousCreatedAt !== null && now <= previousCreatedAt`,
   it is `previousCreatedAt + 1`.
2. Return `{ kind: 0, pubkey, created_at, tags: tags.map(t => [...t]), content: JSON.stringify(content) }`.

Every function has an explicit return type. Add a short doc comment on each
export saying why it exists (a kind 0 replaces the whole profile, so anything
left out is deleted for everyone).

### Done when

Run from the worktree root, all pass:

```sh
npm test
npx biome check src/features/profile/profile-metadata.ts
```

`npm test` has one test that already failed before you started:
`native-http ... redirect`. Ignore that one. Every `profile-metadata` test
must pass. Fix formatting with
`npx biome check --write src/features/profile/profile-metadata.ts`.

## Task 2: the phone app's Edit profile screen (two new files)

Work in the current directory (a git worktree of the nox repo).
Create exactly two NEW files:

- `native/lib/profile-edit.ts`
- `native/screens/EditProfile.tsx`

Do not edit any existing file. Another task will connect the screen to the
app; until then nothing imports it, and that is expected.

Read first: `docs/features/edit-profile/spec.md` (what the screen must do),
`src/features/profile/profile-metadata.ts` (the shared helper you will call),
`native/screens/Search.tsx` (how a screen in this app is written and styled).

### File 1: `native/lib/profile-edit.ts`

```ts
import { emitAppEvent } from '../../src/common/app-events';
import { cacheResolvedProfile } from '../../src/common/profile-fetch';
import { getRelays } from '../../src/features/relays/relays';
import {
  applyProfileEdits,
  type OwnMetadata,
  type ProfileEdits,
  profileMetadataDraft,
  readOwnMetadata,
} from '../../src/features/profile/profile-metadata';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';
import { type PublishResult, publishSigned, signEventWithSession } from './publish';
```

Export two functions:

```ts
/** Your newest kind 0 from every relay you use. Throws when it cannot be read. */
export function loadOwnMetadata(viewer: PubkeyHex): Promise<OwnMetadata> {
  return readOwnMetadata(getRelays(), viewer);
}

export class NotAcceptedError extends Error {}  // name = 'NotAcceptedError', message 'No relay accepted your profile.'

/**
 * Publishes `base` with `edits` applied, keeping every field and tag it did not touch.
 * Throws NotAcceptedError when no relay accepted it; then nothing is cached.
 */
export async function saveOwnMetadata(
  viewer: PubkeyHex,
  base: OwnMetadata,
  edits: ProfileEdits,
): Promise<PublishResult>
```

`saveOwnMetadata` steps:
1. `const content = applyProfileEdits(base.content, edits);`
2. `const draft = profileMetadataDraft(viewer, content, base.tags, base.createdAt);`
3. `const event: NostrEvent = await signEventWithSession(draft);`
4. `const result = await publishSigned(event);`
5. If `result.accepted.length === 0`, throw `new NotAcceptedError(...)`.
6. Cache it so the profile screen shows it at once:
   ```ts
   const profile = content as NostrProfile;
   profile.emojiTags = base.tags.filter((tag) => tag[0] === 'emoji');
   await cacheResolvedProfile(viewer, profile).catch((): void => {});
   ```
7. `emitAppEvent('profile-updated');` (that event name is added by another
   task; a type error on this one line is expected until then, and is the
   only error allowed).
8. Return `result`.

### File 2: `native/screens/EditProfile.tsx`

A default-exported React component `EditProfile` with props
`{ navigation }: { navigation: NativeStackNavigationProp<RootStackParamList> }`
(`import type { RootStackParamList } from '../App';`).

### State and loading

- The viewer: `getSession().pubkey` from `'../../src/common/session'`. If null,
  render the text "Sign in to edit your profile." and nothing else.
- On mount, `loadOwnMetadata(viewer)`:
  - success: keep the result as `base`, and fill a `values` state
    `Record<EditableProfileField, string>` from `base.content[field]` (use the
    value only if it is a string, else `''`).
  - failure: show this text and a "Try again" button that loads again:
    "Couldn't read your current profile from your relays. Saving now could erase it."
- Until loaded, show an `ActivityIndicator` (color `#89a8ff`) and no fields.

### Header Save button

With `useLayoutEffect`, `navigation.setOptions({ headerRight: () => <Pressable ...><Text>Save</Text></Pressable> })`.
- Disabled (text color `#5b6b88`) while loading, while saving, or when `base` is null.
- Enabled text color `#89a8ff`, fontWeight '700', fontSize 16. While saving, the text is "Saving…".
- `accessibilityRole="button"`, `hitSlop={8}`.
- On press: `saveOwnMetadata(viewer, base, edits)` where `edits` holds ONLY
  the fields whose value differs from what was loaded. If nothing changed,
  just `navigation.goBack()`.
  - success: `navigation.goBack()`.
  - `NotAcceptedError`: `Alert.alert('Not saved', 'No relay accepted your profile. Your changes are still here.')`.
  - any other error: `Alert.alert('Not saved', String(error.message ?? error))`.

### Layout (top to bottom, inside a `ScrollView` with `keyboardShouldPersistTaps="handled"`)

1. **Preview** - how others will see you, updating as you type:
   a row with a 56x56 round avatar (`Image` from `pictureUrl(values.picture)`,
   `import { pictureUrl } from '../lib/avatar';`; a blank circle of `#25406e`
   when null), then a column: the display name (or the username, or
   "No name yet" in `#5b6b88`) in `#e8eeff` 18/700, and the NIP-05 under it in
   `#5b6b88` 12. Padding 16, bottom border `rgba(148,163,184,0.14)`.
2. Three groups, each with a section title (`#8ea0c0`, 13, '700', paddingTop 20,
   paddingBottom 8) and its fields:
   - **About you**: Display name (`display_name`), Username (`name`), About
     (`about`, `multiline`, minHeight 96, `textAlignVertical: 'top'`).
   - **Pictures**: Picture URL (`picture`), Banner URL (`banner`).
   - **Links**: Website (`website`), NIP-05 (`nip05`, placeholder
     `you@example.com`), Lightning address (`lud16`, placeholder
     `you@wallet.example`).
3. Each field: a label (`#b9c6de`, 13, '600', marginBottom 6) above a
   `TextInput` styled like Search's input (border `#25406e`, radius 10,
   paddingHorizontal 12, paddingVertical 10, color `#e8eeff`, fontSize 15,
   background `#101a2e`), `placeholderTextColor="#5b6b88"`, marginBottom 14.
   URL fields and NIP-05 / Lightning: `autoCapitalize="none"`,
   `autoCorrect={false}`, `keyboardType="url"` for the URL ones and
   `"email-address"` for NIP-05 and Lightning. Inputs are `editable={!saving}`.
4. Screen background `#0b1220`, horizontal padding 16 for the groups,
   paddingBottom 48.

Every function has an explicit return type where TypeScript allows it.
Start the file with a short doc comment: what the screen is for, and that it
starts from your newest profile on every relay because a kind 0 replaces the
whole profile.

### Done when

Run from the worktree root:

```sh
(cd native && npx tsc --noEmit -p .)
npx biome check native/lib/profile-edit.ts native/screens/EditProfile.tsx
```

The only allowed tsc error is the one about `'profile-updated'` in
`profile-edit.ts`. Fix formatting with `npx biome check --write` on the two files.

## Task 3: connect the Edit profile screen (small edits in 3 existing files)

Work in the current directory (a git worktree of the nox repo).
Edit exactly these three existing files, with the edit tool, one small edit at
a time. Do not rewrite any file. Do not touch any other file.

### 1. `src/common/app-events.ts`

In the `AppEventName` union, after the line `  | 'follows-updated'`, add:

```ts
  /** The viewer published a new profile (kind 0): their profile screen reads it again. */
  | 'profile-updated'
```

### 2. `native/App.tsx`

a. Next to the other screen imports (e.g. after `import Hashtag from './screens/Hashtag';`), add
   `import EditProfile from './screens/EditProfile';` (keep imports sorted alphabetically by path,
   as biome expects).
b. In `export type RootStackParamList = {`, after the line `  Likes: undefined;`, add
   `  EditProfile: undefined;`
c. After the `<Stack.Screen name="Likes" ... />` element, add:

```tsx
          <Stack.Screen
            name="EditProfile"
            component={EditProfile}
            options={{ title: 'Edit profile' }}
          />
```

### 3. `native/screens/Profile.tsx`

a. Add a component above `function FollowButton(`:

```tsx
/** On your own profile, where Follow would be: the way to change it. */
function EditProfileButton({ target }: { target: PubkeyHex }) {
  const viewer = viewerPubkey();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  if (!viewer || viewer !== target || !canWrite()) return null;
  return (
    <Pressable
      onPress={(): void => navigation.navigate('EditProfile')}
      style={styles.follow}
      accessibilityRole="button"
    >
      <Text style={styles.followText}>Edit profile</Text>
    </Pressable>
  );
}
```

b. Find the line `        <FollowButton target={profile.pubkey} />` and add directly under it:
   `        <EditProfileButton target={profile.pubkey} />`

c. In `export function ProfileView`, add a state next to the other `useState` lines:
   `const [version, setVersion] = useState(0);`
   and this effect right before the effect that calls `loadProfile(pubkey, {`:

```tsx
  // A profile you just edited is read again, so the new one shows.
  useEffect(
    (): (() => void) =>
      onAppEvent('profile-updated', (): void => setVersion((v: number): number => v + 1)),
    [],
  );
```

d. Add `version` to the dependency array of the effect that calls
   `loadProfile(pubkey, {` (it currently depends on `pubkey`; make it
   `[pubkey, version]`). Read the end of that effect to find the array.

e. If `onAppEvent`, `useNavigation`, `NativeStackNavigationProp` or
   `RootStackParamList` are not imported yet in this file, add the imports:
   `import { onAppEvent } from '../../src/common/app-events';`,
   `import { useNavigation } from '@react-navigation/native';`,
   `import type { NativeStackNavigationProp } from '@react-navigation/native-stack';`,
   `import type { RootStackParamList } from '../App';`.

### Done when

Run from the worktree root, all pass with no errors:

```sh
(cd native && npx tsc --noEmit -p .)
npx biome check src/common/app-events.ts native/App.tsx native/screens/Profile.tsx native/screens/EditProfile.tsx native/lib/profile-edit.ts
npm test
```

(`npm test`: the `native-http ... redirect` test failed before you started;
ignore only that one.) Biome may report a warning that existed before; only
errors must be fixed. Use `npx biome check --write <file>` for formatting.

