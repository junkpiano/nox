# Where this stands, and what to pick up

Written overnight while you slept. Everything below was run on the Pixel 7a in
a release build, not asserted from a passing type-check.

## Working on the device

| | evidence |
|---|---|
| Home timeline | 201 follows, 745 events, 50 profiles, 4 relays, 4.4s — on the web app's own `fetchFollowList` and `openRelaySubscription` |
| Global timeline | no identity needed; works on a fresh install |
| Profile | banner, avatar, NIP-05, bio, recent posts |
| Thread | root post, deletion check, replies — all three from shared `events-queries.ts` |
| Relay settings | add, remove, refuses to remove the last one; all shared logic |
| Search | 100 found in 8.0s; the same ranking order the browser produced |
| Notifications | 432 from others in 2.0s; tapping one opens the right thread |
| Tabs + stack | native back gesture, pull to refresh |
| Virtualisation | 51 of 745 rows mounted |


Nothing here keeps a second copy of protocol logic. The crypto, the relay
sockets, the follow list and the relay list are all imported straight out of
`../src`.

## Seams added to the shared code

Each leaves web behaviour identical; the web suite is unchanged at 85 of 87,
the two failures being the `message-cache` pair that fail on `main` too.

| seam | why |
|---|---|
| `src/common/kv.ts` | synchronous settings storage; native backs it with `expo-sqlite/kv-store` |
| `src/common/app-events.ts` | the `window` event bus; still dispatches on `window` where one exists, so existing listeners were not touched |
| `src/common/ask.ts` | NIP-42's synchronous `window.confirm`; defaults to deny, exactly as the web code already did without one |
| `native-http.ts` (`setCrossOriginFetch`) | whether CORS applies, which stopped being the same question as "am I Tauri" |

One split, rather than a seam: `user-ranking.ts` holds the pure half of
`user-search.ts` - the tiers, the identifier decoding, the search relay list -
because importing the other half from native drags in `event-render.ts` and
its 2,321 lines of DOM. The 19 tests written for it cover exactly that half,
which is what made the move safe; a first attempt cut through a doc comment
and the tests said so immediately.

## Pick up here

**1. The storage layer — needs you awake.** It is the one piece deliberately
left. The shared stores use compound indexes, cursors with direction,
`IDBKeyRange` and `count()`; a faithful SQLite shim is 400-600 lines whose
correctness lives in key ordering and range boundaries. The failure mode is a
cache that quietly corrupts on a phone, the web suite has no coverage of the DB
layer at all, and writing it means touching shipped web code. Reasoning in
MIGRATION.md.

Until it exists, native refetches from relays every time — slower, and not what
CLAUDE.md asks for, but honest.

**2. Keys and signing.** `expo-secure-store` behind `secret-store.ts`. Note
the Tauri Android keyring *panics* rather than erroring when `ndk_context` is
missing; absorbing that class of problem is why Expo is here. Everything is
read-only until this lands.

**3. The rest of the features**, each on the shared logic: notifications,
messages (NIP-17 — the crypto is already proven under Hermes), wallet, search
(`rankUserResults` and `decodePubkeyQuery` are pure and port as-is; only
`renderUserResults` is DOM), moderation, settings.

## Two things to know before trusting the plan

**The adapter estimate is a floor.** MIGRATION.md says 15 files and 2,444
lines. Three seams came out of reading imports; the fourth only appeared when
the bundler ran. Expect more of those.

**The static analysis under-reports now.** It still says 1,342 portable lines
because `kv.ts` contains the word `localStorage` — as its guarded web
implementation. A regex cannot tell a `typeof` guard from a dependency. The
device is the measure; that is what the Shared code tab is for.

## Running it

```bash
cd native
npm run device        # release APK, installed and launched on the phone
```

Release rather than a dev build: the bundle is embedded so Metro is not in the
loop, and no dev overhead sits in the measurements.

`garden.nox.rn` is a different package id from the Tauri build's
`garden.nox.client`, deliberately — both stay installed so they can be
compared side by side.
