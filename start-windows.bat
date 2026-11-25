@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto node_missing

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto node_too_old

if not exist ".env" (
  echo .env is missing. Run setup-windows.bat first.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo App dependencies are missing. Run setup-windows.bat first.
  pause
  exit /b 1
)

if not exist "node_modules\bcryptjs\package.json" (
  echo App dependencies are missing. Run setup-windows.bat first.
  pause
  exit /b 1
)

if not exist "node_modules\iron-session\package.json" (
  echo App dependencies are missing. Run setup-windows.bat first.
  pause
  exit /b 1
)

if exist "router-ca.crt" set "NODE_EXTRA_CA_CERTS=%CD%\router-ca.crt"

echo Starting the MikroTik Hotspot app.
echo Open http://127.0.0.1:3000 in your browser.
echo Press Ctrl+C in this window to stop the app.
echo.
call npm start
exit /b %errorlevel%

:node_missing
echo Node.js 20 or newer is required. Install Node.js LTS, then run this file again.
pause
exit /b 1

:node_too_old
echo Node.js 20 or newer is required. Install Node.js LTS, then run this file again.
pause
exit /b 1
