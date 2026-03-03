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
│   ├── events-queries.ts    # Follow list, event fetch, delete checks
│   ├── relay-socket.ts      # Raw WebSocket relay communication + NIP-42 AUTH
│   ├── compose.ts           # Post composition overlay
│   ├── reply.ts             # Reply compose
│   ├── search.ts            # Search functionality
│   ├── session.ts           # NIP-07 session & private key handling
│   ├── navigation.ts        # Client-side routing helpers
│   ├── overlays.ts          # Image gallery overlay
│   ├── event-cache.ts       # In-memory event deduplication
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
│   ├── profile/             # Profile view + follow/unfollow
│   ├── reactions/           # Liked posts view
│   ├── relays/              # Relay config, NIP-65, rx-nostr client
│   ├── notifications/       # New post notifications
│   ├── search/              # Search results page
│   ├── settings/            # Settings UI
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

**Global timeline:**
1. `loadGlobalTimeline()` subscribes to all kind 1 events via rx-nostr
2. Author profiles fetched on-demand and cached in IndexedDB
3. Background polling checks for new posts every 30 seconds

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

### URL Routing

Client-side routing via History API (`pushState` / `popstate`):

| Route | View |
|-------|------|
| `/`, `/home` | Home timeline or welcome screen |
| `/global` | Global timeline |
| `/notifications` | Notifications |
| `/reactions` | Liked posts |
| `/search` | Search |
| `/relays` | Relay settings |
| `/settings` | App settings |
| `/about` | About / supported NIPs |
| `/{npub}` | Profile view |
| `/nevent1…`, `/note1…` | Single event view |

nginx is configured to serve `index.html` for all routes (SPA behavior).

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

## Nostr Protocol Reference

| Kind | Meaning |
|------|---------|
| 0 | Profile metadata |
| 1 | Text note |
| 3 | Follow list (contact list) |
| 5 | Deletion request |
| 6 | Repost |
| 7 | Reaction |
| 10002 | Relay list metadata (NIP-65) |

**Supported NIPs:** NIP-01, NIP-02, NIP-03 (OGP), NIP-05, NIP-07, NIP-10 (reply threading), NIP-19, NIP-25 (reactions), NIP-36 (content warnings), NIP-42 (AUTH), NIP-65

## TypeScript Configuration

- `target`: ES2020
- `module`: ESNext
- `moduleResolution`: bundler
- `lib`: ES2020, DOM, DOM.Iterable
- `baseUrl`: `.`
- Path aliases: `@/` → `src/`, `@types/` → `types/`
