# App Links

A `https://nox.garden/npub1…` link opens the phone app instead of the
browser when the site vouches for the app. The vouching is two static files
under `public/.well-known/`, served by the same deploy as the site; the
app's side is in `native/app.json` on `rn-trunk`.

| Platform | File on the site | In the app |
|---|---|---|
| Android | `assetlinks.json` | `android.intentFilters` with `autoVerify` |
| iOS | `apple-app-site-association` | `ios.associatedDomains` |

The app is `garden.nox` on both platforms: Android's package and iOS's bundle
id, which Google Play and Apple each fix for good. Each file here names that
id, and must change with `android.package` or `ios.bundleIdentifier` in
`native/app.json`; a file that names an old id vouches for nothing. The AASA
file also names `garden.nox.rn`, the id the first TestFlight builds used,
until no one has those installed.

Both files are served with `Content-Type: application/json` by the rule in
`public/_headers`, which the AASA file needs because it has no extension.
Neither file may redirect, and both must be reachable at `nox.garden`
itself: a Netlify preview cannot vouch for anything.

## Android

`assetlinks.json` names the package `garden.nox` and the SHA-256 of each
certificate an installed app may be signed with. Android checks the file once,
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

The file lists the **debug keystore's** fingerprint
(`native/android/app/debug.keystore`, which local builds sign with) and the
**upload key's** (`C3:B0:…`, which signs the bundles sent to Google Play).
Play re-signs what it distributes with its own app signing key, shown in
Play Console under Setup → App signing once the first bundle is uploaded;
that fingerprint has to be added too, or links in the Play build open the
browser. Add fingerprints to the array rather than replacing them:

```bash
keytool -list -v -keystore path/to/release.jks -alias <alias> | grep SHA256
```

To see what Android concluded on a device:

```bash
adb shell pm get-app-links garden.nox
adb shell pm verify-app-links --re-verify garden.nox   # ask again now
```

`verified` next to the domain means links open the app. `legacy_failure`
or `1024` means the file was not reachable or did not match.

## iOS

`apple-app-site-association` names `<TeamID>.garden.nox` and the paths
the app claims: people, notes, and hashtags, matching what
`src/common/nostr-link.ts` resolves. Everything else on the site stays in
Safari.

The Team ID is `KHFXF6N2QE`, and the App ID has the Associated Domains
capability turned on in the developer portal; the app's entitlement claims
`applinks:nox.garden`. Apple's CDN fetches the file when the app is
installed and caches it; after changing it, reinstall the app to make it
look again.
