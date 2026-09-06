# App Links

A `https://nox.garden/npub1…` link opens the phone app instead of the
browser when the site vouches for the app. The vouching is two static files
under `public/.well-known/`, served by the same deploy as the site; the
app's side is in `native/app.json` on `rn-trunk`.

| Platform | File on the site | In the app |
|---|---|---|
| Android | `assetlinks.json` | `android.intentFilters` with `autoVerify` |
| iOS | `apple-app-site-association` | `ios.associatedDomains` |

The id `garden.nox.rn` is provisional. When the final package name and
bundle id are chosen, both files here and `android.package` and
`ios.bundleIdentifier` in `native/app.json` change together; a file that
names the old id vouches for nothing.

Both files are served with `Content-Type: application/json` by the rule in
`public/_headers`, which the AASA file needs because it has no extension.
Neither file may redirect, and both must be reachable at `nox.garden`
itself: a Netlify preview cannot vouch for anything.

## Android

`assetlinks.json` names the package `garden.nox.rn` and the SHA-256 of the
certificate the installed app is signed with. Android checks the file once,
when the app is installed or updated, and only for links whose host and
path the manifest names: `nox.garden` under `/npub1`, `/nprofile1`,
`/note1`, `/nevent1` and `/t/`. Any other path on the site stays in the
browser, which is where the privacy policy and the terms belong. There is
no `www.nox.garden`; it does not resolve, and a host that does not exist
cannot vouch.

The filter that ships is the one in the generated Android project,
`native/android/`, which is `expo prebuild` output and not in git. The build
script regenerates it only when the directory is missing, so after changing
`android.intentFilters` in `native/app.json`, delete `native/android` (or run
`npx expo prebuild --platform android --no-install` in `native/`) before
building, or the old filter ships.

The fingerprint in the file is the **debug keystore's**
(`native/android/app/debug.keystore`). Both the debug and the release build
type sign with it today, so it is the only certificate that exists. When a
release keystore is made, add its fingerprint to the array rather than
replacing the debug one, so sideloaded debug builds keep opening links:

```bash
keytool -list -v -keystore path/to/release.jks -alias <alias> | grep SHA256
```

To see what Android concluded on a device:

```bash
adb shell pm get-app-links garden.nox.rn
adb shell pm verify-app-links --re-verify garden.nox.rn   # ask again now
```

`verified` next to the domain means links open the app. `legacy_failure`
or `1024` means the file was not reachable or did not match.

## iOS

`apple-app-site-association` names `<TeamID>.garden.nox.rn` and the paths
the app claims: people, notes, and hashtags, matching what
`src/common/nostr-link.ts` resolves. Everything else on the site stays in
Safari.

The Team ID in the file is a placeholder, `XXXXXXXXXX`, because the app has
no Apple developer registration yet. Universal links will not work until it
is replaced with the real ten-character Team ID and the App ID has the
Associated Domains capability turned on in the developer portal. Apple's
CDN fetches the file on first install and caches it; after changing it,
reinstall the app to make it look again.
