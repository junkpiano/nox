# nox

nox is a relay-first SPA built with TypeScript + Vite.
This README is for developers working on this repository.

## Stack

- TypeScript (strict mode)
- Vite
- Tailwind CSS
- nostr-tools (via ESM import)
- Browser WebSocket API (relay access)
- Bun

## Local Development

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
npm install
```

### Run dev server

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Preview production build

```bash
npm run preview
```

## Project Layout

```text
src/
  app/
    app.ts              # App orchestration, routing, timeline state
    main.ts             # App entrypoint
  common/
    compose.ts          # Compose overlay + shortcuts
    event-render.ts     # Event card rendering, OGP, delete action, nevent reference cards
    events-queries.ts   # Follow list, event fetch, delete checks
    meta.ts             # Dynamic OG/Twitter meta tags
    navigation.ts       # Nav setup + active state
    overlays.ts         # Image overlay
    search.ts           # In-page post search
    session.ts          # Session key handling + logout UI updates
    timeline-cache.ts   # Shared profile fetch cache for timelines
    types.ts            # Shared UI types
  features/
    event/
      event-page.ts     # nevent page loader
    global/
      global-timeline.ts # Global timeline loading logic
    home/
      home-loader.ts    # Initial home timeline loader
      home-timeline.ts  # Home timeline loading logic
      welcome.ts        # Login/welcome screen flow
    profile/
      follow.ts         # Follow/unfollow + publish helper
      profile.ts        # Profile fetch/render
      profile-cache.ts  # Persistent profile cache
      profile-events.ts # Profile timeline loading logic
    relays/
      relays.ts         # Relay config storage/helpers
      relays-page.ts    # Relay management page UI
  utils/
    utils.ts            # Shared utility functions
  index.html
  styles.css

types/
  nostr.ts
  nostr.js
  nostr-tools.d.ts
```

## Key Behavior Notes

- Follow list uses the latest kind `3` event across configured relays.
- Event page checks author delete events (kind `5`) before rendering.
- Own posts show a delete button that publishes kind `5`.
- `nostr:nevent...` references are rendered as embedded mini cards.
- OGP and Twitter embed fetches are cached in-memory by URL.

## NPM Scripts

```json
{
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview"
}
```

## Current Tooling Status

- No test framework configured yet.
- No ESLint/Prettier pipeline configured yet.

## Development Guidelines

- Keep edits in `src/` and run `npm run build` before committing.
- Prefer small modules; avoid large files when adding features.
- Preserve existing TypeScript style (explicit types, clear null checks).
- For relay/network behavior changes, test with multiple relay configurations.
