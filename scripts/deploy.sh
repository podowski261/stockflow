#!/usr/bin/env bash
# =====================================================================
#  STOCKFLOW - Deploiement depuis GitHub (a lancer SUR le serveur)
#  Usage :  bash ~/deploy-stockflow.sh      (lien cree une seule fois)
#     ou :  bash scripts/deploy.sh          (depuis le dossier de l'app)
#
#  1. sauvegarde la base (backups/, garde les 10 dernieres)
#  2. aligne le code sur GitHub (origin/main) - la base, les uploads,
#     les factures et le secret de session ne sont pas suivis par git :
#     ils ne sont JAMAIS touches
#  3. npm install seulement si package.json / package-lock.json ont change
#  4. verifie la syntaxe de server.js puis redemarre pm2 (app « stockflow »)
# =====================================================================
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
APP="${STOCKFLOW_PM2_NAME:-stockflow}"

echo ">> Dossier : $PWD"
mkdir -p backups
if [ -f database.sqlite ]; then
    B="backups/database-avant-deploy-$(date +%Y%m%d-%H%M%S).sqlite"
    cp database.sqlite "$B" && echo ">> Base sauvegardee : $B"
    ls -1t backups/database-avant-deploy-*.sqlite 2>/dev/null | tail -n +11 | xargs -r rm --
fi

echo ">> Recuperation du code depuis GitHub..."
git fetch origin main
OLD="$(git rev-parse HEAD 2>/dev/null || echo none)"
git reset --hard origin/main

if [ "$OLD" = "none" ] || ! git diff --quiet "$OLD" HEAD -- package.json package-lock.json; then
    echo ">> Dependances modifiees : npm install"
    npm install --omit=dev
fi

node -c server.js
pm2 restart "$APP"
echo ">> Deploye : $(git log --oneline -1)"
