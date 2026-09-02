# AGENTS.md - Nostr SPA TypeScript Development Guide

This guide provides essential information for agentic coding assistants working on the Nostr SPA TypeScript project.

## Project Overview
A single-page application for browsing the Nostr network, built with Vite and vanilla TypeScript. No backend server — the app runs entirely in the browser, connects directly to Nostr relays via WebSocket, and caches data in IndexedDB.

## Build & Development Commands

```bash
# Development server (http://localhost:3000)
npm run dev

# Type-check and build for production (output: dist/)
npm run build

# Preview production build locally
npm run preview

# Docker (multi-stage: Bun build + nginx:alpine serve)
docker build -t nostr-app .
docker run -p 8080:80 nostr-app
```

## Code Quality

```bash
# Lint check
npm run lint

# Format check
npm run format

# Auto-format files
npm run format:write

# Full Biome check (lint + format)
npm run check
```

Biome (`biome.json`) handles both linting and formatting — there is no ESLint or Prettier.

## Testing

```bash
npm test
```

Uses Node's built-in test runner. Test files live in `tests/` and compile to `.tmp/test-dist/`.

## Package Manager

Both npm and Bun are in use. `bun.lock` is committed. Prefer `bun` for installing packages; `npm run <script>` for running scripts.

## Architecture Overview

### Module Structure

```
src/
├── app/                     # Entry point, routing, global state
│   ├── main.ts              # Vite entry (imports styles + app.ts)
│   ├── app.ts               # App orchestration
│   ├── app-state.ts         # Global app state definitions
│   └── app-routes.ts        # Route handlers
│
├── common/                  # Shared utilities
│   ├── event-render.ts      # Event card HTML generation
│   ├── client-tag.ts        # NIP-89 client tag: writes "nox", reads others'
│   ├── media-type.ts        # Image vs video, and the video poster frame
│   ├── timeline-status.ts   # Batched NIP-38 statuses for a whole timeline
│   ├── events-queries.ts    # Follow list, event fetch, delete checks
│   ├── relay-socket.ts      # Raw WebSocket relay communication + NIP-42 AUTH
│   ├── compose.ts           # Post composition overlay
│   ├── reply.ts             # Reply compose
│   ├── search.ts            # Search functionality
│   ├── session.ts           # NIP-07 session & private key handling
│   ├── navigation.ts        # Client-side routing helpers
│   ├── overlays.ts          # Image gallery overlay
│   ├── event-cache.ts       # Compatibility wrapper over the main event cache
│   ├── timeline-cache.ts    # Profile cache for timeline rendering
│   ├── deletion-targets.ts  # Deleted event tracking
│   ├── meta.ts              # Dynamic OG meta tags
│   ├── nip05.ts             # NIP-05 verification
│   ├── promise-utils.ts     # Promise utility helpers
│   ├── cache-settings.ts    # Cache configuration UI
│   ├── sync/                # Service worker & background sync
│   └── db/                  # IndexedDB abstraction layer
│       ├── index.ts         # Public DB API
│       ├── indexeddb.ts     # DB initialization & connection pooling
│       ├── events-store.ts  # Event persistence
│       ├── profiles-store.ts
│       ├── timelines-store.ts
│       ├── timeline-builder.ts
│       ├── timeline-queries.ts
│       ├── event-writer.ts
│       ├── metadata-store.ts
│       └── types.ts
│
├── features/                # Feature modules
│   ├── event/               # Single event page (nevent / note)
│   ├── global/              # Global timeline
│   ├── home/                # Home timeline (follows)
│   ├── messages/            # NIP-17 private messages (gift wrap, DM relays)
│   ├── moderation/          # Mute list (NIP-51) and reports (NIP-56)
│   ├── profile/             # Profile view + follow/unfollow, NIP-38 status
│   ├── reactions/           # Posts you liked (labelled "Likes" in the UI)
│   ├── relays/              # Relay config, NIP-65, rx-nostr client
│   ├── notifications/       # Reactions, replies and mentions addressed to you
│   ├── search/              # Search results page
│   ├── settings/            # Settings UI
│   ├── wallet/              # Lightning wallet over NIP-47 (NWC)
│   ├── about/               # About / supported NIPs page
│   └── broadcast/           # Broadcast mode (relay stress test)
│
├── utils/
│   └── utils.ts             # Display names, avatars, OGP, Twitter embeds, emoji
│
├── index.html               # SPA template
└── styles.css               # Tailwind CSS directives
```

### Key Libraries

| Library | Purpose |
|---------|---------|
| `nostr-tools` ^2.23.0 | Nostr signing, verification, nip19 encoding/decoding |
| `rx-nostr` ^3.6.2 | Reactive relay client (RxJS-based) |
| `rxjs` ^7.8.2 | Reactive programming (observables) |
| `emoji-dictionary` ^1.0.12 | Emoji shortcode → Unicode |
| `tailwindcss` ^3.4.19 | Utility-first CSS |
| `vite` ^6.4.1 | Build tool & dev server |
| `@biomejs/biome` ^2.3.15 | Linter + formatter |

### Data Flow

**Home timeline (logged-in users):**
1. NIP-07 browser extension (Alby, nos2x) provides pubkey
2. `fetchFollowList()` fetches kind 3 event from relays
3. `loadHomeTimeline()` fetches kind 1 posts from followed pubkeys
4. Events deduplicated via `Set<string>`, stored in IndexedDB
5. `renderEvent()` generates HTML cards
6. Every 30 seconds a poll asks for newer posts; they wait behind a
   "N new posts" row at the top of the list until clicked (`new-posts-row.ts`,
   rule shared with native in `src/common/new-posts.ts`)

**Global timeline:**
1. `loadGlobalTimeline()` subscribes to all kind 1 events via rx-nostr
2. Author profiles fetched on-demand and cached in IndexedDB
3. Same 30-second poll and new-posts row as home

**Event page (`/nevent1...` / `/note1...`):**
1. Decode nevent with nip19, extract event ID + relay hints
2. Fetch event from relays (relay hints intersected with user's relay list)
3. Render event card, then in parallel: fetch profile, check deletion, load reactions
4. Build ancestor chain by walking `e` tags (reply → root → legacy positional)
5. Fetch replies and render as threaded tree

### Relay Communication

Two relay communication patterns coexist:

- **`relay-socket.ts`**: Low-level `WebSocket` wrapper used for follow list, event fetch, deletion checks, replies. Opens a socket, sends REQ, waits for EOSE, closes.
- **`rx-nostr-client.ts`**: RxNostr wrapper used for timeline streaming. Reactive observable pipeline; supports NIP-42 AUTH challenge-response.

Default relays are defined in `src/features/relays/relays.ts`.

### IndexedDB Schema

- **events** — kind 1 posts; indexed by pubkey, kind, created_at, storedAt
- **profiles** — kind 0 metadata; LRU-evicted by accessedAt
- **timelines** — oldest/newest timestamps per timeline (for pagination)
- **metadata** — miscellaneous key-value storage

Pruning limits: 10,000 events max; 14-day TTL general, 30-day TTL home timeline.

### Cache Source Of Truth

- Use `nostr_cache_v2` as the single IndexedDB source of truth for cached app data.
- Read from cache first. Only fetch from relays when the required cache entry is missing.
- After fetching from relays, write the result back to the main cache and render from that cached shape.
- Do not introduce parallel caches for the same entity type. Compatibility wrappers are acceptable only if they delegate to `nostr_cache_v2`.
- When cached data and freshly fetched data both exist, treat the cached value as the authoritative render source for that code path unless the task explicitly changes cache invalidation behavior.

### URL Routing

Client-side routing via History API (`pushState` / `popstate`):

| Route | View |
|-------|------|
| `/`, `/home` | Home timeline or welcome screen |
| `/global` | Global timeline |
| `/messages` | Private messages (NIP-17) |
| `/wallet` | Lightning wallet (NIP-47) |
| `/notifications` | Notifications |
| `/reactions` | Posts you liked, shown as "Likes" |
| `/search` | Search |
| `/relays` | Relay settings |
| `/settings` | App settings |
| `/about` | About / supported NIPs |
| `/{npub}` | Profile view |
| `/nevent1…`, `/note1…` | Single event view |

nginx is configured to serve `index.html` for all routes (SPA behavior).

### Rendering someone else's media

Extensions decide the element. `classifyMediaUrl()` reads the extension off the
URL's *path*, so a signed link keeps its type and a host like `mp4.example.com`
does not acquire one. Images and videos were once one branch, which put videos
in an `<img>`: a browser cannot decode one there, but it downloads the whole
file before finding that out, and the gallery then fetched it again on tap.

Videos carry `preload="metadata"` and a `#t=0.1` fragment so the browser paints
a frame rather than a black box, and they are kept out of the gallery's image
list - the gallery is an `<img>`, which is exactly what a video must not be
handed to.

### Strings other people wrote

Client names (NIP-89) and user statuses (NIP-38) are rendered next to a name,
and both are chosen by whoever published the event. Each is flattened to one
line, capped, and escaped; a URL attached to a status is followed only if it is
`http`. A newline in a one-line field is either a mistake or an attempt to take
more room than the line.

The client tag is written on an **allow-list** of kinds, never a deny-list: the
events that must not carry an extra tag - relay AUTH, HTTP auth, wallet
requests, anything reaching a gift wrap - are exactly the ones nobody remembers
to exclude.

## Deployment

| | |
|---|---|
| Production | Cloudflare Workers, `nox.garden`, `npm run deploy` from a maintainer machine |
| Pull request previews | Netlify, `deploy-preview-<n>--nox-preview.netlify.app` |

`netlify.toml` names bun explicitly because three lockfiles are checked in and
Netlify picks one by detection, and it carries the SPA redirect that
`wrangler.jsonc` expresses as `not_found_handling`.

The OGP proxy (a separate Worker, `junkpiano/nostr-proxy`) answers with a CORS
header only for origins it knows. `nox.garden`, the preview site and its
`<alias>--` namespace are allowed there; a new deploy origin needs a change in
that repository or every link card on it fails silently.

## Native Shell (Tauri v2)

The same frontend ships as a web app and as a Tauri app for Android, desktop and
(via CI) iOS. `src-tauri/` wraps `dist/` as-is; there is no separate codebase.

Build: `bun run android:dev`, `bun run android:build`, `bun run android:bundle`.
Signing and release steps are in `docs/android-release.md`; iOS CI is in
`docs/ios-testflight.md`.

### Deciding what a particular store allows

Layout branches on viewport width, not the runtime, and that stays true.
`platform.ts` exists for a different question: the App Store treats a connected
Lightning wallet as a wallet and asks that wallets come from developers
registered as organisations, while Google's policy exempts non-custodial ones.
So the wallet is hidden on **native iOS only** - a browser is `web` even on an
iPhone, because nobody using Safari went through App Review.

Zapping is unaffected. Without a connected wallet the composer shows the
invoice as a QR code, which is a payment request rather than a wallet, and is
how zapping worked before wallet support existed.

Both the drawer entry and the route are closed. Hiding a nav item is not the
same as closing a door someone can still type, link to, or reach through
history.

### Deciding what is native-only

Layout branches on **viewport width**, not on the runtime, so the mobile web
build gets the same treatment as the app and there is one layout to maintain.
`isNativeRuntime()` from `src/common/native-http.ts` gates only what is
meaningless in a browser tab.

### Things that behave differently under Tauri

These were each found the hard way; the workaround is already in the code.

- **`env(safe-area-inset-*)` is always 0 in Android's WebView**, even under
  edge-to-edge. `MainActivity` pads the content view from the real
  `WindowInsets` instead. The CSS is still correct for iOS and the web.
- **Service workers cannot be registered** from the custom protocol origin, so
  background sync is web-only and skipped natively.
- **CORS does not apply** to requests issued from Rust, so OGP, oEmbed and LNURL
  are fetched directly on native and through the proxy worker on web.
- **Tauri does not populate `ndk_context`**, which the Android keyring backend
  needs, and that backend *panics* rather than returning an error when it is
  missing. `secret_store.rs` defers store creation and wraps it in
  `catch_unwind`; never set `panic = "abort"` in `[profile.release]`.
- **`nostr-tools` NIP-17/47 helpers require a raw private key**, which a NIP-07
  extension never provides. The sealing and request layers are written locally
  so both key sources work.

### Secrets

The Nostr private key and the NWC connection secret both live in the platform
credential store via `src/common/secret-store.ts`, never in `localStorage`. Both
are cleared on logout.

## Code Style Guidelines

### TypeScript

- Strict mode enabled: `strict`, `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- All functions must have explicit return types
- Use `const` for immutable values, `let` for mutable
- Use branded types for domain strings: `PubkeyHex`, `Npub`, `EventId`
- Import types with `import type` when possible
- Module resolution: `"bundler"` (Vite-style); `.js` extensions not required in imports

### Imports

```typescript
import { nip19 } from 'nostr-tools';
import type { NostrEvent, PubkeyHex, Npub } from '../../types/nostr';
import { renderEvent } from '../common/event-render.js';
```

### Error Handling

- Use try/catch for all async operations
- Relay errors are logged but must not block other relays
- Null-check all DOM element references before use
- Return `null` (not throw) when a relay misses an event

### DOM & HTML

- Use `querySelector` / `getElementById` with explicit null checks
- Generate HTML via template literals; sanitize user content before rendering
- Use Tailwind CSS utility classes for styling

### Coding Practices

- When making changes, always ensure they are corrected to avoid any side effects (e.g. update all call sites when renaming a function)
- Keep data flow consistent with the cache model: cache-first, remote-on-miss, then cache the remote result.

## Nostr Protocol Reference

| Kind | Meaning |
|------|---------|
| 0 | Profile metadata |
| 1 | Text note |
| 3 | Follow list (contact list) |
| 5 | Deletion request |
| 6 | Repost |
| 7 | Reaction |
| 13 | Seal (NIP-59, inside a gift wrap) |
| 14 | Chat message (NIP-17, never signed or published directly) |
| 1059 | Gift wrap (NIP-59, the only public part of a DM) |
| 1984 | Report (NIP-56) |
| 10000 | Mute list (NIP-51, entries encrypted to self) |
| 10002 | Relay list metadata (NIP-65) |
| 10050 | DM relay list (NIP-17) |
| 30315 | User status (NIP-38, read only) |
| 23194/23195 | Wallet request / response (NIP-47) |

**Supported NIPs:** NIP-01, NIP-02, NIP-05, NIP-07, NIP-10 (reply threading),
NIP-17 (private messages), NIP-19, NIP-25 (reactions), NIP-30 (custom emoji),
NIP-36 (content warnings), NIP-38 (user status, read only), NIP-42 (AUTH),
NIP-44 (encryption), NIP-47 (wallet connect), NIP-51 (mute list), NIP-56
(reports), NIP-57 (zaps), NIP-59 (gift
wrap), NIP-65 (relay list), NIP-89 (client tag), NIP-92 (`imeta`, read only)

## TypeScript Configuration

- `target`: ES2020
- `module`: ESNext
- `moduleResolution`: bundler
- `lib`: ES2020, DOM, DOM.Iterable
- `baseUrl`: `.`
- Path aliases: `@/` → `src/`, `@types/` → `types/`
