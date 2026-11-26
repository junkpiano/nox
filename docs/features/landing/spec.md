# Landing page

## Purpose

The first page someone sees on nox.garden. Its job is to turn a visitor into a
reader: say in seconds what nox is and why it is worth trying, then let them
start reading or sign in.

## Behaviour

The page shows, in this order:

1. The wordmark with the waxing moon.
2. The promise: what nox is (a fast client for Nostr, the open social
   network), and that there is no account and no email.
3. The proof of speed: the measured time from tap to timeline, with what it
   was measured on.
4. "Start reading" as the one primary action, and "Get the app" as a quiet
   second one that leads to `/apps`.
5. Under them, one note on data: nox has no server that stores your data,
   link previews pass through a proxy, and both are open source.
6. "Already on Nostr?" with the existing sign-in choices, unchanged.
7. The footer: About, Terms, Privacy.

On a wide screen the wordmark sits on the left, and the rest on the right.

A link to nox.garden shared anywhere (Nostr, X, Slack, iMessage) unfurls into a
card with a picture, the name and the promise, not a bare URL.

## Acceptance

- LANDING-1: The landing page says nox has no server that stores your data,
  says link previews pass through a proxy, and links to the source of nox
  (github.com/junkpiano/nox) and of the proxy (github.com/junkpiano/nostr-proxy).
- LANDING-2: The landing page states the measured time from tap to timeline
  and what it was measured on, with the same figures as `/apps`.
- LANDING-3: "Start reading" is the only primary button. A "Get the app" link
  leads to `/apps`, and is not shown inside the desktop or phone app.
- LANDING-4: `/` serves Open Graph and Twitter card tags with a description
  matching the page's promise and a 1200x630 `og:image`, with `twitter:card`
  set to `summary_large_image`, and no `og:url`: the same HTML is served for
  every route, so one URL there would point every shared post and profile at
  the home page.
- LANDING-5: The page works at 360px wide with no horizontal scroll, keeps
  visible keyboard focus, and the moon does not animate under
  `prefers-reduced-motion`.

## Not doing

- Showing real posts on the landing page. The terms gate shows nothing from
  the network before the terms are accepted, and a stranger's post is the
  wrong first impression to leave to chance.
- App Store and Google Play badges. The apps are not public yet; `/apps` says
  where each one stands. Add badges when a store listing is live.
- Analytics, sign-up counters or testimonials. nox has no server to count
  with, and invented praise is worse than none.

## Open

- Is 0.4 s (the Android app's cached timeline after a cold start, release
  build) still the figure to quote, or is there a newer measurement? The
  landing page, `/apps` and the share card quote it, and a test keeps the
  landing figure equal to `/apps`.
- Should the desktop layout also show a picture of the phone app? It needs a
  real screenshot with posts you are happy to show.
