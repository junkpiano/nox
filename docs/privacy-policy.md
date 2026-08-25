# Privacy Policy for nox

Last updated: 25 August 2026

nox is a client for the Nostr network. It has no backend of its own and no user
accounts. This policy describes what the app does with your information, which
is mostly: leaves it on your device, and sends what you ask it to send to the
relays you choose.

## What we collect

**Nothing.** The developer of nox operates no server that receives your data,
runs no analytics, and has no way to identify you or see what you do in the
app. There is no sign-up, no telemetry, and no crash reporting.

## What stays on your device

- **Your private key**, if you sign in with one. It is stored in the operating
  system's credential store (Android Keystore, iOS Keychain, macOS Keychain,
  Windows Credential Manager, or Linux kernel keyring), which encrypts it at
  rest. It is never transmitted anywhere.
- **Your wallet connection secret**, if you connect a Lightning wallet, in the
  same credential store.
- **Cached posts, profiles and timelines**, in the browser or app database, so
  the app can start without refetching everything.
- **Decrypted private messages**, in the same database, so they do not have to
  be decrypted again on every visit.
- **Your settings**, such as your relay list and display preferences.

Uninstalling the app, or clearing site data in a browser, removes all of it.

## What leaves your device, and where it goes

### Relays you choose

Posting, reading, following, reacting and messaging all work by talking to
Nostr relays. **Relays are independent servers, not operated by nox.** When the
app connects to one it necessarily reveals your IP address and what you ask
for, and anything you publish becomes public on that relay.

You control which relays the app uses, in Relay settings. The defaults are
`relay.snort.social`, `relay.damus.io`, `nos.lol` and `yabu.me`.

Nostr is a public network. **Posts, reactions, follows and profile information
are public by design** and can be read, copied and stored by anyone, including
people not using nox. Deleting a post asks relays to remove it; not all of them
will.

Private messages are end-to-end encrypted, and relays cannot read them or see
who you are talking to. Your mute list is also encrypted and readable only by
you. Reports you submit are public, because they exist for relay operators to
act on.

### Other services, when a feature needs them

| Service | When it is contacted | What it receives |
|---|---|---|
| `nostr-proxy-worker.junkpiano.workers.dev` | Web version only, to read link previews | The URL being previewed, and your IP address |
| `publish.twitter.com`, `platform.twitter.com` | A post links to X/Twitter | The linked post, and your IP address |
| `robohash.org` | A profile has no picture | A hash of that profile's public key |
| `nostrcheck.me` | You upload an image | The image, and your IP address |
| Any web server | A post links to it, or a profile has a picture hosted there | Your IP address |
| A NIP-05 provider's domain | Verifying a `name@domain` identifier | The name being verified |
| Your Lightning wallet's relay | You connect a wallet or send a zap | The payment request |

The native app fetches link previews directly rather than through the proxy, so
that hop does not exist there.

## Children

nox is not directed at children. Nostr is a public network carrying unmoderated
content from strangers.

## Content from other people

Posts you see come from the Nostr network, not from us, and are not
pre-moderated. You can mute accounts and report content from within the app; see
the Terms of Use.

## Changes

Material changes will be reflected here, with the date above updated.

## Contact

Open an issue at https://github.com/junkpiano/nox/issues.
