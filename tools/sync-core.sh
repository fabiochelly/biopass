#!/bin/sh
# Copie le cœur JS partagé (web) dans l'extension. À lancer après toute modification de core.js / icons.js.
set -e
cd "$(dirname "$0")/.."
mkdir -p extension/lib
for f in core.js icons.js; do
  cp server/web/assets/$f extension/lib/$f
done
echo "extension/lib mis à jour"
