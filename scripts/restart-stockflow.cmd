@echo off
REM Double-cliquez ce fichier pour redemarrer StockFlow (pm2 restart all).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-stockflow.ps1"
pause
