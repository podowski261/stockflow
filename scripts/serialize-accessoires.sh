#!/usr/bin/env bash
# =====================================================================
#  STOCKFLOW - Attribution des n° de serie uniques aux accessoires
#  encore en code « A000xxx » (a lancer SUR le serveur, une seule fois).
#  Arrete l'app, sauvegarde + modifie la base, puis la redemarre
#  (redemarrage garanti meme en cas d'erreur).
#  Sortie : labels-accessoires.json (liste pour les etiquettes 60x40).
# =====================================================================
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
APP="${STOCKFLOW_PM2_NAME:-stockflow}"

echo ">> Dossier : $PWD"
pm2 stop "$APP"
trap 'pm2 start "$APP" >/dev/null && echo ">> $APP redemarre"' EXIT
node scripts/serialize-accessoires.js database.sqlite --apply --out labels-accessoires.json
