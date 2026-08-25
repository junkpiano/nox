# Android release builds

The signing config is already wired up. What is missing is the key itself,
which cannot live in the repository.

## Create the upload key

Run once, and keep the result. Choose your own password; nothing in this repo
supplies one.

```bash
keytool -genkey -v -keystore ~/nox-upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

**Back this file up before going further, and store the password in a password
manager.** Without Play App Signing, losing this key means you can never update
the app again under the same listing — Google cannot recover it, and a new key
means a new listing and losing every existing install. Enrolling in Play App
Signing at first upload is strongly recommended: Google then holds the real
signing key and this file becomes a replaceable upload key.

Keep it outside the repository. `.gitignore` covers `*.jks`, `*.keystore`,
`keystore.properties` and `key.properties` as a safety net, but the reliable
protection is not putting the key in the tree at all.

## Point the build at it

Create `src-tauri/gen/android/keystore.properties`, which is gitignored:

```properties
keyAlias=upload
password=<the password you chose>
storeFile=/absolute/path/to/nox-upload-keystore.jks
```

Both the store password and the key password are read from `password`, so use
the same value for each when generating the key.

Signing is opt-in. Without this file the release build still succeeds and
produces an unsigned artifact, so contributors and debug builds are unaffected.

## Build

```bash
bun run tauri android build --aab    # Play submission format
bun run tauri android build --apk    # sideloading and manual testing
```

Artifacts land under `src-tauri/gen/android/app/build/outputs/`. A signed APK is
named `app-universal-release.apk`; an unsigned one keeps an `-unsigned` suffix,
which is the quickest way to tell whether signing was picked up.

Verify before uploading:

```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs <apk>
jarsigner -verify <aab>
```

## Size

The release AAB is around 26 MB and Play splits it per ABI, so a device
downloads roughly 19 MB. Play's limit is 200 MB, so there is no need for ABI
splits, asset packs, or any size-driven change to the build.

## CI

Do not commit the keystore to run builds in CI. Encode it into a secret and
write the properties file at build time:

```yaml
- name: Set up Android signing
  run: |
    cd src-tauri/gen/android
    echo "keyAlias=${{ secrets.ANDROID_KEY_ALIAS }}" > keystore.properties
    echo "password=${{ secrets.ANDROID_KEY_PASSWORD }}" >> keystore.properties
    base64 -d <<< "${{ secrets.ANDROID_KEY_BASE64 }}" > $RUNNER_TEMP/keystore.jks
    echo "storeFile=$RUNNER_TEMP/keystore.jks" >> keystore.properties
```

Where `ANDROID_KEY_BASE64` is `base64 -w0 nox-upload-keystore.jks`.

## Play Store requirements

Beyond signing, first submission also needs:

- App icons. `src-tauri/icons/` still holds Tauri's placeholders.
- A privacy policy URL.
- Data safety declarations. The app has no backend; keys stay on device in the
  platform credential store, and posts go directly to user-selected relays.
- Content rating questionnaire.
