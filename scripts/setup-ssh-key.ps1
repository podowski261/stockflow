# =====================================================================
#  StockFlow - Configuration SSH (A LANCER UNE SEULE FOIS)
#  Cree une cle SSH locale (si absente) et l'installe sur le serveur.
#  Le mot de passe du serveur vous sera demande UNE SEULE FOIS ici ;
#  ensuite, restart-stockflow.ps1 fonctionnera sans aucun mot de passe.
#  Aucun mot de passe n'est stocke sur le disque.
# =====================================================================
$ErrorActionPreference = 'Stop'
$Server  = 'infinity@192.168.88.10'
$KeyPath = Join-Path $HOME '.ssh\id_ed25519'

if (-not (Test-Path (Join-Path $HOME '.ssh'))) {
    New-Item -ItemType Directory -Path (Join-Path $HOME '.ssh') | Out-Null
}

if (-not (Test-Path "$KeyPath.pub")) {
    Write-Host "Generation d'une cle SSH ed25519 ..." -ForegroundColor Cyan
    # --% : indispensable sous PowerShell pour passer une passphrase vide (-N "")
    ssh-keygen --% -t ed25519 -N "" -f %USERPROFILE%\.ssh\id_ed25519
} else {
    Write-Host "Cle deja presente : $KeyPath.pub" -ForegroundColor Yellow
}

Write-Host "Installation de la cle sur $Server (mot de passe demande une fois) ..." -ForegroundColor Cyan
# La cle publique est envoyee via stdin -> aucun probleme de guillemets.
Get-Content "$KeyPath.pub" | ssh -o StrictHostKeyChecking=accept-new $Server `
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo '>> Cle installee avec succes.'"

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nOK. Test de connexion sans mot de passe :" -ForegroundColor Green
    ssh $Server "pm2 status"
    Write-Host "`nTermine. Vous pouvez maintenant lancer restart-stockflow.ps1" -ForegroundColor Green
} else {
    Write-Host "Echec de l'installation de la cle (code $LASTEXITCODE)." -ForegroundColor Red
}
