# iOS builds and TestFlight

The iPhone app is the React Native app in `native/` (`garden.nox`). No
maintainer machine runs macOS, so `.github/workflows/ios-testflight.yml` is
the only place it is built, on a GitHub macOS runner.

## What runs when

| Trigger | Behaviour |
|---|---|
| Merge to `main` | Signed build, uploaded to TestFlight. |
| Manual run (Actions → iOS TestFlight → Run workflow) | Signed build; the `upload` input decides whether it goes to TestFlight or is only kept as an artifact. |

The build number is the workflow's run number, so every upload is new to App
Store Connect. The version is `expo.version` in `native/app.json`.

## How a build is made

1. `bun install` at the root (the app imports `../src`) and `npm ci` in `native/`.
2. `expo prebuild --platform ios` generates `native/ios`, which is not committed.
3. The Apple Distribution certificate goes into a temporary keychain and the
   provisioning profile into place.
4. The app target alone is switched to manual signing with that profile. Set on
   the command line instead, the settings would reach the Pods targets, which
   cannot take a profile.
5. `xcodebuild archive`, then `xcodebuild -exportArchive` with
   `destination: upload`, authenticated with the App Store Connect API key.

## Apple setup (done once, in a browser)

No Mac is needed: the certificate request is made with `openssl`.

1. **App ID**: Certificates, Identifiers & Profiles → Identifiers → ＋ → App
   IDs → App. Bundle ID `garden.nox` (explicit), capability **Associated
   Domains**.
2. **Certificate**: make a key and request with
   `openssl genrsa -out dist.key 2048` and
   `openssl req -new -key dist.key -out dist.csr -subj "/emailAddress=…/CN=…/C=JP"`,
   then Certificates → ＋ → **Apple Distribution**, upload `dist.csr`, download
   the `.cer`.
3. **Profile**: Profiles → ＋ → **App Store Connect** → App ID `garden.nox`
   → that certificate → name it exactly **`nox App Store`** (the workflow
   refers to it by name).
4. **App record**: App Store Connect → Apps → ＋ New App → iOS, bundle ID
   `garden.nox`.
5. **API key**: App Store Connect → Users and Access → Integrations → Team
   Keys. The role must be allowed to upload builds.

Build the `.p12` from the key and certificate:

```bash
openssl x509 -inform DER -in distribution.cer -out dist.pem
openssl pkcs12 -export -legacy -inkey dist.key -in dist.pem \
  -name "nox Apple Distribution" -out dist.p12
```

`-legacy` matters: macOS's `security import` may reject OpenSSL 3's default
encryption.

## Secrets

| Secret | Contents |
|---|---|
| `IOS_DIST_CERTIFICATE` | `dist.p12`, base64 |
| `IOS_DIST_CERTIFICATE_PASSWORD` | Its password |
| `IOS_PROVISIONING_PROFILE` | The `.mobileprovision`, base64 |
| `APPLE_TEAM_ID` | Team ID |
| `APPLE_API_KEY_CONTENT` | The `.p8`, as is or base64 |
| `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER` | Issuer ID |

The last four are shared with the macOS workflow.

## Not yet

- Signatures are checked in JavaScript on iOS: `native/modules/nox-crypto` has
  only an Android side. On Android that check was most of a 17-second launch.
- The certificate and profile expire after a year; renew both and update the
  three `IOS_*` secrets.
