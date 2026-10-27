#!/usr/bin/env bash
# Compile BioPass Android dans Docker (rien à installer sur l'hôte à part Docker).
#   ./build.sh            → APK release signée dans dist/biopass.apk
#   ./build.sh test       → tests unitaires JVM (crypto, modèle)
#   ./build.sh gradle …   → commande Gradle arbitraire (ex. ./build.sh gradle tasks)
# Le SDK Android et le cache Gradle sont conservés dans le volume Docker « biopass-android-cache ».
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=eclipse-temurin:17-jdk
VOLUME=biopass-android-cache
UG="$(id -u):$(id -g)"

docker volume create "$VOLUME" >/dev/null
# Le volume est créé par root : on le donne une fois à l'utilisateur courant.
docker run --rm -v "$VOLUME":/cache "$IMAGE" sh -c \
  "mkdir -p /cache/sdk /cache/gradle /cache/home && [ \"\$(stat -c %u:%g /cache/home)\" = '$UG' ] || chown $UG /cache /cache/sdk /cache/gradle /cache/home"

TTY=()
[ -t 1 ] && TTY=(-t)
exec docker run --rm "${TTY[@]}" --network host -u "$UG" \
  -v "$VOLUME":/cache -v "$PWD":/project -w /project \
  -e HOME=/cache/home -e GRADLE_USER_HOME=/cache/gradle -e ANDROID_HOME=/cache/sdk \
  -e ANDROID_USER_HOME=/cache/home/.android \
  -e BIOPASS_IT_SERVER="${BIOPASS_IT_SERVER:-}" -e BIOPASS_IT_INFO="${BIOPASS_IT_INFO:-}" \
  "$IMAGE" bash /project/tools/container-build.sh "$@"
