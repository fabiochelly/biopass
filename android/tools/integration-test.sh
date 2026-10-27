#!/usr/bin/env bash
# Test d'intégration : serveur PHP réel (copie temporaire) + core.js (node) + couche Kotlin (Docker).
# Prérequis sur l'hôte : php, node, docker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ANDROID="$ROOT/android"
PORT=${PORT:-8782}
T=$(mktemp -d)
cp -r "$ROOT/server" "$T/srv"
rm -rf "$T/srv/data"; mkdir "$T/srv/data"
echo "<?php return ['registration_code' => 'famille', 'data_dir' => __DIR__ . '/data', 'access_key' => 'cle-test'];" > "$T/srv/config.php"
# Mode routeur : tout passe par index.php (contrôle de la clé d'accès)
php -S 127.0.0.1:$PORT -t "$T/srv" >"$T/php.log" 2>&1 &
PHP_PID=$!
trap 'kill $PHP_PID 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api.php" && break; sleep 0.1; done

# Adresse saisie par l'utilisateur, clé d'accès comprise
SERVER="http://127.0.0.1:$PORT/?k=cle-test"
# Le fichier d'échange doit être visible du conteneur : on le met sous android/build/.
mkdir -p "$ANDROID/build/it"
INFO="$ANDROID/build/it/info.json"
rm -f "$INFO" "$INFO.kt"
export BIOPASS_CORE="$ROOT/server/web/assets/core.js"

node "$ANDROID/tools/it-js.mjs" setup "$SERVER" "$INFO"
BIOPASS_IT_SERVER="$SERVER" BIOPASS_IT_INFO="/project/build/it/info.json" \
  "$ANDROID/build.sh" gradle :app:testReleaseUnitTest --tests app.biopass.core.IntegrationTest --rerun
node "$ANDROID/tools/it-js.mjs" verify "$SERVER" "$INFO"
rm -f "$INFO" "$INFO.kt"
echo "== Test d'intégration réussi"
