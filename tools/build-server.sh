#!/bin/sh
# Prépare server/ pour le déploiement :
#  - extension : zip (installation manuelle), zip Chrome Web Store (dist/), et .crx signé + update.xml
#    (installation et mises à jour automatiques via une politique du navigateur) si 'public_url' est
#    renseigné dans server/config.php ;
#  - APK Android (si construite : android/build.sh) ;
#  - génération de server/web.php et server/downloads.php à partir de server/web/.
# À relancer après toute modification, puis déployer server/ SANS web/ ni data/.
set -e
cd "$(dirname "$0")/.."
tools/sync-core.sh
OUT=server/web/downloads
mkdir -p "$OUT" dist
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

EXT_VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/manifest.json)
cfg() { php -r 'define("BIOPASS", 1); $c = is_file("server/config.php") ? require "server/config.php" : []; echo $c[$argv[1]] ?? "";' "$1"; }
PUBLIC_URL=$(cfg public_url | sed 's#/*$##')
ACCESS_KEY=$(cfg access_key)
STORE_URL=$(cfg extension_store_url)

# Installation manuelle : dossier biopass-extension/ dans un zip
cp -r extension "$T/biopass-extension"
rm -f "$OUT/biopass-extension.zip"
(cd "$T" && zip -qrX - biopass-extension) > "$OUT/biopass-extension.zip"

# Chrome Web Store : manifest.json à la racine du zip
rm -f dist/biopass-extension-webstore.zip
(cd extension && zip -qrX - .) > dist/biopass-extension-webstore.zip

# Extension signée (.crx) pour l'installation par politique (ExtensionSettings / update_url)
EXT_ID=""
UPDATE_URL=""
CHROMIUM=$(command -v chromium || command -v chromium-browser || command -v brave || command -v google-chrome || true)
if [ -n "$PUBLIC_URL" ] && [ -n "$CHROMIUM" ]; then
  PEM=extension-signing/biopass-extension.pem   # clé de signature : à sauvegarder (elle fixe l'identifiant)
  if [ ! -f "$PEM" ]; then
    mkdir -p extension-signing && chmod 700 extension-signing
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PEM" 2>/dev/null
    chmod 600 "$PEM"
    echo "Nouvelle clé de signature de l'extension : $PEM (à sauvegarder)"
  fi
  # Numéro de build (4e composante de la version signée) : incrémenté dès que le contenu de l'extension
  # change, pour que les navigateurs voient toujours une version plus récente (1.2.0 → 1.2.0.1, 1.2.0.2…).
  HASH=$(cd extension && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16)
  BUILD=$(cat extension-signing/build-number 2>/dev/null || echo 0)
  if [ "$(cat extension-signing/build-hash 2>/dev/null)" != "$HASH" ]; then
    BUILD=$((BUILD + 1))
    echo "$BUILD" > extension-signing/build-number
    echo "$HASH" > extension-signing/build-hash
  fi
  EXT_VER="$EXT_VER.$BUILD"
  Q=${ACCESS_KEY:+&k=$ACCESS_KEY}
  UPDATE_URL="$PUBLIC_URL/index.php?f=downloads/update.xml$Q"
  cp -r extension "$T/crx"
  php -r '$f = $argv[1]; $m = json_decode(file_get_contents($f), true); $m["update_url"] = $argv[2]; $m["version"] = $argv[3];
          file_put_contents($f, json_encode($m, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");' "$T/crx/manifest.json" "$UPDATE_URL" "$EXT_VER"
  "$CHROMIUM" --headless=new --no-message-box --user-data-dir="$T/profile" --pack-extension="$T/crx" --pack-extension-key="$PEM" >/dev/null 2>&1 || true
  [ -f "$T/crx.crx" ] || { echo "Échec de la signature de l'extension avec $CHROMIUM"; exit 1; }
  cp "$T/crx.crx" "$OUT/biopass.crx"
  EXT_ID=$(openssl pkey -in "$PEM" -pubout -outform DER 2>/dev/null | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p')
  CRX_URL=$(printf '%s' "$PUBLIC_URL/index.php?f=downloads/biopass.crx$Q" | sed 's/&/\&amp;/g')
  cat > "$OUT/update.xml" <<EOF
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$EXT_ID'>
    <updatecheck codebase='$CRX_URL' version='$EXT_VER' />
  </app>
</gupdate>
EOF
  # Script d'installation : sh install-brave.sh   ou   curl -fsSL '<url du script>' | sh
  ESC_URL=$(printf '%s' "$UPDATE_URL" | sed 's/[&|\\]/\\&/g')   # « & » est spécial dans un remplacement sed
  sed -e "s|@ID@|$EXT_ID|g" -e "s|@UPDATE_URL@|$ESC_URL|g" tools/install-brave.sh.in > "$OUT/install-brave.sh"
  chmod +x "$OUT/install-brave.sh"
else
  rm -f "$OUT/biopass.crx" "$OUT/update.xml" "$OUT/install-brave.sh"
  [ -n "$PUBLIC_URL" ] || echo "public_url absent de server/config.php : pas d'extension signée (.crx)"
fi

APK_VER=""
if [ -f android/dist/biopass.apk ]; then
  cp android/dist/biopass.apk "$OUT/biopass.apk"
  APK_VER=$(python3 -I tools/apk-version.py android/dist/biopass.apk | cut -d' ' -f2) # version réelle de l'APK construite
else
  echo "android/dist/biopass.apk absent : lancez android/build.sh (APK non publiée)"
fi

php -r '
[, $o, $extVer, $apkVer, $id, $update, $store] = $argv;
$out = [];
foreach (["extension" => ["biopass-extension.zip", $extVer], "apk" => ["biopass.apk", $apkVer]] as $k => [$f, $v]) {
    if ($v !== "" && is_file("$o/$f")) $out[$k] = ["version" => $v, "size" => filesize("$o/$f"), "date" => date("c", filemtime("$o/$f"))];
}
if (isset($out["extension"])) $out["extension"] += array_filter(["id" => $id, "update_url" => $update, "store_url" => $store]);
file_put_contents("$o/versions.json", json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
' "$OUT" "$EXT_VER" "$APK_VER" "$EXT_ID" "$UPDATE_URL" "$STORE_URL"
php server/bin/build-web.php
[ -z "$EXT_ID" ] || echo "Extension signée : identifiant $EXT_ID, version $EXT_VER"

# ---------------------------------------------------------------- déploiement (deploy.conf)
# Envoie le serveur (sans web/ ni data/) et met à jour l'app sur le téléphone branché.
# Désactivé par BIOPASS_NO_DEPLOY=1 (tests) ou en l'absence de deploy.conf.
[ -z "${BIOPASS_NO_DEPLOY:-}" ] && [ -f deploy.conf ] || exit 0
. ./deploy.conf
if [ -n "${DEPLOY_HOST:-}" ] && [ -n "${DEPLOY_PATH:-}" ]; then
  echo "Envoi vers $DEPLOY_HOST:$DEPLOY_PATH …"
  # data/ n'est jamais envoyé ni supprimé ; aucun fichier distant n'est effacé
  # RemoteCommand=none : l'entrée SSH peut ouvrir un shell interactif (cd …), incompatible avec rsync
  rsync -rlptz --chmod=D755,F644 --exclude=/web/ --exclude=/data/ --exclude='*.tmp' \
    -e 'ssh -o RemoteCommand=none -o RequestTTY=no' server/ "$DEPLOY_HOST:$DEPLOY_PATH/" && echo "Serveur à jour (OPcache relit les fichiers de BioPass tout seul)."
fi
if [ "${DEPLOY_PHONE:-0}" = 1 ] && [ -f android/dist/biopass.apk ] && command -v adb >/dev/null; then
  NEW=$(python3 -I tools/apk-version.py android/dist/biopass.apk | cut -d' ' -f1)
  for dev in $(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }'); do
    CUR=$(adb -s "$dev" shell dumpsys package app.biopass 2>/dev/null | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -1)
    [ -n "$CUR" ] || continue # appareil sans BioPass (téléviseur…) : on n'y touche pas
    if [ "$CUR" -lt "$NEW" ]; then
      adb -s "$dev" install -r android/dist/biopass.apk >/dev/null && echo "Téléphone $dev : BioPass mis à jour (versionCode $CUR → $NEW)."
    else
      echo "Téléphone $dev : BioPass déjà à jour (versionCode $CUR)."
    fi
  done
fi
