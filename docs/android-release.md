# Android builds

The Android app is the React Native app in `native/` (`garden.nox`).
`.github/workflows/android-build.yml` builds it on every push to `main` and on
demand (Actions → Android → Run workflow).

## What a run makes

| File | For |
|---|---|
| `app-release.aab` | Google Play (Play Console → Testing → upload) |
| `app-release.apk` | Installing directly on a phone |

Both are kept on the run for 14 days, in the artifact `nox-android-<code>`.
The version code is `1000 + run number`, so every bundle is new to Google
Play; the version name is `expo.version` in `native/app.json`.

## Signing

With the two secrets below, both files are signed with the Play **upload
key**, and the bundle can go to Google Play. Without them, the build still
runs and is signed with the debug key: it installs, but Play refuses it.

| Secret | Contents |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE` | The upload keystore (`upload.jks`), base64 |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Its password (PKCS12: the key's too) |

The key alias is `upload`. Google re-signs what it distributes with the app
signing key it holds (Play App Signing), so the upload key can be reset
through the Play Console if it is lost.

## On a phone attached to this machine

`npm run device` in `native/` builds a release APK and installs it; see
`native/run-device.sh`.
