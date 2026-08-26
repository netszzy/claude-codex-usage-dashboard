@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PHONE_DISPLAY=on"

if exist "%~dp0release\win-unpacked\AI Usage Dashboard.exe" (
  start "" "%~dp0release\win-unpacked\AI Usage Dashboard.exe" --phone-display
  exit /b 0
)

for %%F in ("%~dp0release\AI-Usage-Dashboard-*-portable.exe") do (
  if exist "%%~fF" (
    start "" "%%~fF" --phone-display
    exit /b 0
  )
)

if not exist node_modules\electron\dist\electron.exe (
  echo [Missing] Electron is not installed. Run npm install first.
  echo.
  pause
  exit /b 1
)

set "DASHBOARD_HOST=127.0.0.1"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\main.js" --phone-display
