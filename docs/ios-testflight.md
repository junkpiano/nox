# iOS builds and TestFlight

Building for iOS needs macOS. No maintainer machine here has one, so
`.github/workflows/ios-testflight.yml` is the only way to produce an iOS build,
and also the only place iOS breakage gets noticed.

## What runs when

| Trigger | Behaviour |
|---|---|
| Tag `v*` | Signed build, uploaded to TestFlight. |
| Manual run | Signed build; the `upload` input decides whether it ships. |

**Not run on pull requests.** An earlier version tried an unsigned compile
check there, on the assumption that one was possible. It is not: xcodebuild
refuses to build without a development team, so every run failed with the same
error and told us nothing.

Once the credentials below are configured, adding `pull_request` back to the
workflow will give a check that can actually pass. Until then the workflow warns
rather than pretending to build.

## What has to exist before a build can ship

None of this is in the repository, and none of it can be.

1. **Apple Developer Program membership.** 99 USD a year.
2. **A registered Bundle ID** matching `identifier` in `src-tauri/tauri.conf.json`,
   currently `garden.nox.client`.
3. **An app record in App Store Connect** for that Bundle ID.
4. **An App Store Connect API key** with Admin access, from Users and Access →
   Integrations. Note that:
   - The `.p8` private key can be downloaded exactly once.
   - The download button only appears after reloading the page.
   - The Issuer ID sits above the key table; the Key ID is the table column.

The workflow uses Xcode's automatic signing driven by that API key, so no
distribution certificate or provisioning profile needs to be exported by hand.

## Secrets

Set these under Settings → Secrets and variables → Actions.

| Secret | Value |
|---|---|
| `APPLE_API_KEY_CONTENT` | `base64 -i AuthKey_XXXXX.p8` — the whole file |
| `APPLE_API_KEY_ID` | Key ID, e.g. `2X9R4HXF34` |
| `APPLE_API_ISSUER` | Issuer ID, a UUID |
| `APPLE_TEAM_ID` | Team ID from the Apple Developer membership page |

The key is base64-encoded because it is a multi-line PEM file, and it is
deleted from the runner in an `always()` step even though runners are
ephemeral.

`APPLE_API_KEY_CONTENT` is also the flag the workflow reads to decide whether it
can sign. Setting it turns on the signed path; leaving it unset keeps every run
a compile check.

## First upload

Tag a release, or run the workflow manually:

```bash
gh workflow run ios-testflight.yml
```

The first build to reach App Store Connect usually takes 10-30 minutes to
finish processing before it appears in TestFlight, and Apple emails about any
missing export-compliance answers.

## What is wired, and what is only assumed

The iOS pieces that could be settled by reading the code are in place:

- `src-tauri/Info.ios.plist` carries the photo library and camera usage
  descriptions. The compose button's file input opens the system picker, and
  iOS terminates an app that reaches the picker without a description for the
  source the person chose - a crash, not a denied permission. Tauri picks this
  file up from beside `tauri.conf.json`, so it survives the regeneration of
  `gen/apple`.
- `bundle.iOS.minimumSystemVersion` is `15.0`. The stylesheet uses the `inset`
  shorthand, which Safari only understands from 14.5; autoprefixer does not
  expand shorthands, so on iOS 14 those elements lose their positioning
  outright. Tauri's default is 13.0, which would ship that breakage.
- The keyring, the HTTP plugin, the capability set and the safe-area handling
  are all platform-neutral already. Safe areas in particular need nothing
  iOS-specific: `env(safe-area-inset-*)` reports zero on Android, where
  `MainActivity` pads from the real insets instead, so each platform is served
  by the mechanism that works there.

The rest cannot be confirmed without a build, and is listed here so the first
one knows where to look rather than rediscovering it:

- **Keychain.** `apple-native-keyring-store` backs the private key, the DM
  cache key and the wallet secret. Nothing has exercised it on a device.
- **Secure context.** Message cache encryption needs `crypto.subtle`, which
  browsers withhold outside a secure context. Whether `tauri://localhost`
  counts as one is untested. If it does not, the cache simply stops persisting
  rather than falling back to plaintext, so the failure is a refetch on every
  launch, not a leak.
- **`PrivacyInfo.xcprivacy`.** Apple requires a privacy manifest for App Store
  submission. Which required-reason APIs Tauri and WKWebView actually touch can
  only be read off a real build, and a declaration written from guesswork is
  itself grounds for rejection, so this is deliberately absent until there is a
  build to inspect.

## Notes

`src-tauri/gen/apple` is not committed. The workflow runs `tauri ios init` on
every run, so a stale generated project cannot drift from `tauri.conf.json`.

App icons are still Tauri's placeholders. TestFlight accepts them, but App
Store review will not.
