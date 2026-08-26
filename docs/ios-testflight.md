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

## Notes

`src-tauri/gen/apple` is not committed. The workflow runs `tauri ios init` on
every run, so a stale generated project cannot drift from `tauri.conf.json`.

App icons are still Tauri's placeholders. TestFlight accepts them, but App
Store review will not.
