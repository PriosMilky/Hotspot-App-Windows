@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto node_missing

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto node_too_old

if not exist ".env" (
  copy ".env.example" ".env" >nul
  if errorlevel 1 goto env_copy_failed
  echo Created .env from .env.example.
)

if not exist "node_modules\express\package.json" (
  goto install_dependencies
)
if not exist "node_modules\bcryptjs\package.json" (
  goto install_dependencies
)
if not exist "node_modules\iron-session\package.json" (
  goto install_dependencies
)
goto dependencies_ready

:install_dependencies
  echo Installing app dependencies...
  call npm install
  if errorlevel 1 goto install_failed

:dependencies_ready
echo.
call npm run setup-auth -- --if-needed
if errorlevel 1 goto auth_setup_failed

if exist "router-ca.crt" set "NODE_EXTRA_CA_CERTS=%CD%\router-ca.crt"

echo.
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

:env_copy_failed
echo Could not create .env. Check that .env.example exists and the app folder is writable.
pause
exit /b 1

:install_failed
echo Dependency installation failed. Check your internet connection and try again.
pause
exit /b 1

:auth_setup_failed
echo Account setup failed. Run "npm run setup-auth" from this folder, then start the app again.
pause
exit /b 1
