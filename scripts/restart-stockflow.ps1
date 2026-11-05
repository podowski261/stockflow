# =====================================================================
#  StockFlow - Redemarrage de l'application (pm2 restart all)
#  Prerequis : avoir lance setup-ssh-key.ps1 une fois (cle SSH installee).
# =====================================================================
$ErrorActionPreference = 'Stop'
$Server = 'infinity@192.168.88.10'

Write-Host "Redemarrage de StockFlow sur $Server ..." -ForegroundColor Cyan
ssh -o StrictHostKeyChecking=accept-new $Server "pm2 restart all"

if ($LASTEXITCODE -eq 0) {
    Write-Host "OK - pm2 restart all termine." -ForegroundColor Green
    ssh $Server "pm2 status"
} else {
    Write-Host "ECHEC (code $LASTEXITCODE)." -ForegroundColor Red
    Write-Host "Si un mot de passe est demande, lancez d'abord setup-ssh-key.ps1" -ForegroundColor Yellow
}
