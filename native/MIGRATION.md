# Porting nox to React Native

The web app at the repository root is **not** being replaced. It stays exactly
as it is, ships to `nox.garden`, and keeps its own build. This directory is a
second front end onto the same protocol code.

## What settled this

A throwaway prototype (`prototypes/rn-home-timeline`, branch
`worktree-rn-prototype`) answered two questions on a Pixel 7a before any of
this was written.

**Virtualisation is real.** `FlatList` held 125 of 951 rows mounted at
y=88,634px, having risen to 141 and settled — it does not grow with depth. The
web build keeps all 383 cards in a 73,809px document. The WebView's cost is a
function of how far you have read; React Native's is not, and no CSS closes
that.

**The feel is native.** The one thing no instrument here could measure, judged
by hand: *「プロトタイプみたけど、とてもよい。android nativeっぽい。」*

**The crypto runs.** This was the gate, and it was checked properly rather
than assumed, in the release build, on the device:

    PASS  secp256k1 keygen          5ms
    PASS  sign + verify kind 1      50ms
    PASS  NIP-44 encrypt/decrypt    130ms
    PASS  NIP-59 seal + gift wrap   366ms

The gift wrap check builds the shape this app builds by hand — rumour, seal,
wrap under a throwaway key — unwraps it as the recipient, and asserts the
rumour survived, the seal names the real author, and the outer wrap does not.

Two things did **not** favour the move and are recorded so nobody rediscovers
them as good news: memory is a wash (372MB against the Tauri app's 352MB,
while that app was drawing images and link cards and the prototype was not),
and an early claim that WSL2 breaks Fast Refresh was simply wrong — the
tunnel works; the command was mistyped.

## The shape of the work, measured

Counting transitively — a module is only portable if everything it imports is
too — the codebase divides cleanly:

| | files | lines |
|---|---:|---:|
| Platform adapters to write | 15 | 2,444 |
| Ports unchanged, once those exist | 39 | 5,644 |
| Genuine UI rewrite | 56 | 16,752 |

The middle row is the interesting one. Before the adapters, only 17 files and
1,342 lines were portable; a handful of leaf modules were holding the rest
hostage:

| leaf | own lines | lines it blocks |
|---|---:|---:|
| `common/cache-settings.ts` | **29** | **15,544** |
| `common/secret-store.ts` | 135 | 15,952 |
| `common/session.ts` | 171 | 14,335 |
| `common/db/*` (3 files) | 563 | 13,711 |
| `features/relays/relays.ts` | 175 | 13,214 |
| `common/relay-socket.ts` | 451 | 12,693 |

A 29-line module gating 15,544 lines is not a porting problem, it is a seam
problem. Abstracting these unlocks `events-queries.ts`, `message-crypto.ts`,
the whole IndexedDB store layer and the reaction logic — 4,302 lines that then
move without being touched.

So the work is not "rewrite 21,000 lines". It is: write 2,444 lines of
adapters, move 5,644 lines unchanged, and rewrite the 16,752 lines that are
genuinely `innerHTML`, Tailwind and DOM events.

## Adapters

Each is a seam, not a rewrite: the web keeps its implementation, native gets
its own, and everything above the seam stops caring.

| module | web today | native |
|---|---|---|
| `cache-settings.ts` | `localStorage` flag | MMKV / AsyncStorage |
| `secret-store.ts` | Tauri keyring plugin | `expo-secure-store` |
| `session.ts` | `localStorage` + NIP-07 | secure store; no extension exists |
| `db/indexeddb.ts` | IndexedDB | `expo-sqlite` |
| `db/{event-writer,timeline-builder,metadata-store}.ts` | leak raw IDB | same API over SQLite |
| `relays/relays.ts` | `localStorage` | key/value adapter |
| `relay-socket.ts` | browser `WebSocket` | RN `WebSocket` (already proven) |
| `mute-state.ts`, `profile-cache.ts`, `wallet-store.ts` | `localStorage` | key/value adapter |
| `utils/utils.ts` | mixed; split | pure half moves, DOM half stays |
| `ogp-parse.ts`, `native-http.ts` | `DOMParser` / CORS proxy | RN fetch, no proxy needed |

`native-http.ts` is a special case worth noting: CORS does not apply to
requests from native, so the OGP proxy worker is unnecessary here — the same
reason the Tauri build already bypasses it.

## Order of work

1. **Adapters first.** Nothing above them can be trusted until they exist.
2. **Storage.** `expo-sqlite` behind the existing `db/index.ts` surface, so the
   store layer above it never learns what changed.
3. **Keys.** `expo-secure-store`. Note the Tauri Android keyring *panics*
   rather than erroring when `ndk_context` is missing — that whole class of
   problem is what Expo is here to absorb.
4. **A vertical slice**: home timeline → profile → thread, on the shared
   `events-queries.ts` rather than on the prototype's ad-hoc client.
5. Then the rest, feature by feature, each on the shared logic.

## Rules

- **Never fork logic to make it fit.** If a shared module resists, put a seam
  under it; two copies of the NIP-59 sealing code is exactly the failure this
  whole plan is trying to avoid.
- The web app is not to be modified except to introduce a seam, and a seam
  must leave its behaviour identical.
- Cache stays the single source of truth per `CLAUDE.md`: read cache first,
  fetch on miss, write back, render from cache.
