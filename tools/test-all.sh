#!/bin/sh
# Lance tous les tests JS : serveur PHP + extension (Chromium headless requis).
#   tools/test-all.sh
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d)
trap 'set +e; kill $P1 $P2 2>/dev/null; sleep 0.5; rm -rf "$T" 2>/dev/null; true' EXIT
BIOPASS_NO_DEPLOY=1 tools/build-server.sh >/dev/null
# déploiement simulé : /biopass/ = server/ sans web/ ni data/, comme sur le serveur réel
mkdir -p "$T/www/biopass"
cp -r server/index.php server/api.php server/web.php server/downloads.php server/src server/bin "$T/www/biopass/"
cp server/config.sample.php "$T/www/biopass/config.php"
sed -i "s|'registration_code' => 'changez-moi'|'registration_code' => 'famille'|; s|'access_key' => ''|'access_key' => 'cle-test'|" "$T/www/biopass/config.php"
php -S 127.0.0.1:8765 -t "$T/www" >/dev/null 2>&1 & P1=$!
php -S 0.0.0.0:8766 -t tools/test-sites >/dev/null 2>&1 & P2=$!
SERVER='http://127.0.0.1:8765/biopass/?k=cle-test'
sleep 0.5
tools/sync-core.sh
echo "== Vecteurs de test"; node tools/make-vectors.mjs
echo "== Clé d'accès"
NGINX404=8eec510e57f5f732fd2cce73df7b73ef   # md5 du 404 nginx pour un .php inexistant
check404() {  # $1 = URL relative à /biopass/, $2 = options curl
  body=$(curl -s $2 -o "$T/r" -w '%{http_code}' "http://127.0.0.1:8765/biopass/$1")
  [ "$body" = 404 ] || { echo "ÉCHEC : /biopass/$1 → $body"; exit 1; }
  case "$1" in *.php*) [ "$(md5sum < "$T/r" | cut -d' ' -f1)" = $NGINX404 ] || { echo "ÉCHEC : /biopass/$1 ne ressemble pas au 404 nginx"; exit 1; } ;; esac
}
for u in "" "?k=faux" "index.php" "index.php?f=assets/app.js" "api.php?a=prelogin" "index.php?f=downloads/biopass.apk"; do check404 "$u"; done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$SERVER")" = 200 ] || { echo "ÉCHEC : clé refusée"; exit 1; }
echo "OK : 404 sans clé (identique à nginx), 200 avec"
echo "== Serveur";          node tools/test-server.mjs "$SERVER"
echo "== Sauvegardes";      node tools/test-backups.mjs "$SERVER" "$T/www/biopass"
echo "== Send";             node tools/test-send.mjs "$SERVER"
echo "== Extension";        node tools/seed-extension.mjs "$SERVER" && S="$T" BP_SERVER="$SERVER" node tools/test-extension.mjs
echo "== Extension : connexion permanente"; BP_SERVER="$SERVER" node tools/test-extension-persist.mjs
echo "== Fichiers internes (même avec la clé)"
for u in src/ bin/ data/ data/users/ data/vaults/ data/locks/ config.php src/lib.php src/api.php src/404.php src/index.php src/favicon.php src/send.php src/icons.php bin/admin.php bin/build-web.php web.php downloads.php \
         $(cd "$T/www/biopass" && find data -type f | head -50); do
  check404 "$u" "-b bpk=cle-test"
done
echo "OK : $(cd "$T/www/biopass" && find data -type f | wc -l) fichiers de données et tout le code répondent le 404 nginx"
