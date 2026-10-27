#!/usr/bin/env bash
# Exécuté DANS le conteneur par build.sh.
set -euo pipefail
cd /project

PLATFORM="platforms;android-35"
BUILD_TOOLS="build-tools;35.0.0"
CMDLINE_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip

# 1. SDK Android (une seule fois, mis en cache dans le volume)
SDKM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKM" ]; then
  echo "== Installation des outils en ligne de commande Android"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/tools.zip" "$CMDLINE_URL"
  (cd "$tmp" && jar xf tools.zip)
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  chmod +x "$ANDROID_HOME"/cmdline-tools/latest/bin/*
  rm -rf "$tmp"
fi
if [ ! -d "$ANDROID_HOME/platforms/android-35" ] || [ ! -d "$ANDROID_HOME/build-tools/35.0.0" ]; then
  echo "== Installation de $PLATFORM et $BUILD_TOOLS"
  yes | "$SDKM" --licenses >/dev/null || true
  "$SDKM" --install "$PLATFORM" "$BUILD_TOOLS" >/dev/null
fi

# 2. Clé de signature (générée une seule fois ; À SAUVEGARDER)
if [ ! -f signing/biopass.jks ]; then
  echo "== Création de la clé de signature signing/biopass.jks"
  mkdir -p signing
  pw=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
  keytool -genkeypair -keystore signing/biopass.jks -storetype PKCS12 -alias biopass \
    -keyalg RSA -keysize 3072 -validity 36500 -storepass "$pw" -keypass "$pw" \
    -dname "CN=BioPass" >/dev/null 2>&1
  printf 'storeFile=biopass.jks\nstorePassword=%s\nkeyAlias=biopass\nkeyPassword=%s\n' "$pw" "$pw" > signing/keystore.properties
  chmod 600 signing/biopass.jks signing/keystore.properties
fi

G=(./gradlew --no-daemon --console=plain -q)
case "${1:-release}" in
  release)
    "${G[@]}" :app:assembleRelease
    mkdir -p dist
    cp app/build/outputs/apk/release/app-release.apk dist/biopass.apk
    echo "== APK : dist/biopass.apk ($(du -k dist/biopass.apk | cut -f1) Kio)"
    ;;
  test)
    ./gradlew --no-daemon --console=plain :app:testReleaseUnitTest --rerun
    ;;
  sdk)
    echo "SDK prêt"
    ;;
  gradle)
    shift
    ./gradlew --no-daemon --console=plain "$@"
    ;;
  *)
    echo "Usage : build.sh [release|test|gradle …]" >&2; exit 2
    ;;
esac
