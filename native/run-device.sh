#!/usr/bin/env bash
# Build a release APK and put it on the attached phone.
#
# Release rather than a dev build: the bundle is embedded, so Metro is not in
# the loop, and dev-mode overhead is not in the measurement either. Signed
# with the debug keystore, which is what the Expo template already does.
#
# WSL2 cannot see the USB device, so the APK goes via a Windows path and is
# installed by the Windows adb.
set -euo pipefail

ADB="/mnt/c/Users/yusuke/AppData/Local/Android/Sdk/platform-tools/adb.exe"
PKG="garden.nox.rn"
HERE="$(cd "$(dirname "$0")" && pwd)"

export JAVA_HOME="$HOME/.local/jdk-21"
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$JAVA_HOME/bin:$PATH"

if [ ! -d "$HERE/android" ]; then
  echo "==> prebuild"
  (cd "$HERE" && npx expo prebuild --platform android --no-install)
fi

echo "==> assembleRelease"
(cd "$HERE/android" && ./gradlew assembleRelease)

APK="$HERE/android/app/build/outputs/apk/release/app-release.apk"
cp "$APK" /mnt/c/Users/yusuke/AppData/Local/Temp/nox-rn.apk
sync
"$ADB" install -r 'C:\Users\yusuke\AppData\Local\Temp\nox-rn.apk'
"$ADB" shell am force-stop "$PKG"
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
echo "LAUNCHED"
