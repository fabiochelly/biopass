#!/bin/sh
# Banc de performance de l'extension : serveur PHP local, coffre de 800 entrées avec icônes 128 px,
# mesures dans Chromium headless (voir tools/bench-extension.mjs).
#   tools/bench-extension.sh            RUNS=9 tools/bench-extension.sh
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d)
trap 'set +e; kill $P1 $P2 2>/dev/null; sleep 0.5; rm -rf "$T" 2>/dev/null; true' EXIT
BIOPASS_NO_DEPLOY=1 tools/build-server.sh >/dev/null
mkdir -p "$T/www/biopass"
cp -r server/index.php server/api.php server/web.php server/downloads.php server/src server/bin "$T/www/biopass/"
cp server/config.sample.php "$T/www/biopass/config.php"
sed -i "s|'registration_code' => 'changez-moi'|'registration_code' => 'famille'|; s|'access_key' => ''|'access_key' => 'cle-test'|" "$T/www/biopass/config.php"
PHP_CLI_SERVER_WORKERS=4 php -S 127.0.0.1:8765 -t "$T/www" >/dev/null 2>&1 & P1=$!
php -S 0.0.0.0:8766 -t tools/test-sites >/dev/null 2>&1 & P2=$!
SERVER='http://127.0.0.1:8765/biopass/?k=cle-test'
sleep 0.5
node tools/seed-bench.mjs "$SERVER" "${ENTRIES:-800}"
BP_SERVER="$SERVER" node tools/bench-extension.mjs
