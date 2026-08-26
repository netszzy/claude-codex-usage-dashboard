@echo off
chcp 65001 >nul
cd /d "%~dp0"

if exist "%~dp0release\win-unpacked\AI Usage Dashboard.exe" (
  start "" "%~dp0release\win-unpacked\AI Usage Dashboard.exe"
  exit /b 0
)

for %%F in ("%~dp0release\AI-Usage-Dashboard-*-portable.exe") do (
  if exist "%%~fF" (
    start "" "%%~fF"
    exit /b 0
  )
)

if not exist node_modules (
  echo [Missing] npm dependencies not installed. Run:
  echo   npm install
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Missing] electron is not installed.
  echo Install dependencies first: npm install
  echo.
  pause
  exit /b 1
)

echo Starting Claude / Codex usage dashboard in floating desktop window...
set "DASHBOARD_HOST=127.0.0.1"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\main.js"
