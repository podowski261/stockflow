@echo off
setlocal EnableExtensions
title STOCKFLOW
cd /d "%~dp0"

set "PORT=4300"
set "URL=http://localhost:%PORT%/login.html"

echo ============================================
echo    STOCKFLOW - demarrage
echo ============================================
echo.

REM --- Node.js est-il installe ? ---
where node >nul 2>&1
if errorlevel 1 (
  echo [ERREUR] Node.js n'est pas installe.
  echo Telechargez-le sur https://nodejs.org puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

REM --- Le serveur tourne-t-il deja sur le port ? ---
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('localhost',%PORT%);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
  echo Le serveur tourne deja. Ouverture du navigateur...
  start "" "%URL%"
  exit /b 0
)

REM --- Dependances presentes ? (premiere utilisation) ---
if not exist "node_modules" (
  echo Installation des dependances ^(premiere fois, patientez^)...
  call npm install
  echo.
)

REM --- Demarrage du serveur dans une fenetre reduite ---
echo Demarrage du serveur...
start "STOCKFLOW Server" /min cmd /c "node server.js"

REM --- Attendre que le serveur reponde ---
echo Attente du serveur...
set /a tries=0
:wait
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('localhost',%PORT%);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% GEQ 30 (
  echo [ERREUR] Le serveur ne repond pas. Consultez la fenetre "STOCKFLOW Server".
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:ready
echo Serveur pret. Ouverture du navigateur...
start "" "%URL%"
echo.
echo STOCKFLOW est lance : %URL%
echo Pour arreter, fermez la fenetre "STOCKFLOW Server".
timeout /t 4 /nobreak >nul
exit /b 0
