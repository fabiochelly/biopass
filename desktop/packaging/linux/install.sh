#!/bin/sh
# Installe l'app de bureau pour l'utilisateur courant (lanceur + icônes), sans sudo.
#   desktop/packaging/linux/install.sh      (après cargo build --release)
set -e
cd "$(dirname "$0")/../.."
BIN="$PWD/target/release/biopass"
[ -x "$BIN" ] || { echo "Compilez d'abord : (cd desktop && cargo build --release)"; exit 1; }
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
mkdir -p "$HOME/.local/bin" "$DATA/applications"
ln -sf "$BIN" "$HOME/.local/bin/biopass"      # lien : une recompilation met l'app à jour
sed "s|^Exec=biopass|Exec=$HOME/.local/bin/biopass|" packaging/linux/biopass.desktop > "$DATA/applications/biopass.desktop"
SVG=../server/web/icon.svg
for s in 32 48 64 128 256 512; do
  mkdir -p "$DATA/icons/hicolor/${s}x${s}/apps"
  rsvg-convert -w $s -h $s "$SVG" -o "$DATA/icons/hicolor/${s}x${s}/apps/biopass.png"
done
mkdir -p "$DATA/icons/hicolor/scalable/apps" && cp "$SVG" "$DATA/icons/hicolor/scalable/apps/biopass.svg"
command -v update-desktop-database >/dev/null && update-desktop-database "$DATA/applications" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$DATA/icons/hicolor" 2>/dev/null || true
echo "BioPass installé : $DATA/applications/biopass.desktop → $HOME/.local/bin/biopass"
