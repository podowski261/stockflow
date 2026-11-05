@echo off
setlocal EnableExtensions
title STOCKFLOW - arret
set "PORT=4300"
echo Arret du serveur STOCKFLOW (port %PORT%)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
echo Termine.
timeout /t 2 /nobreak >nul
exit /b 0
