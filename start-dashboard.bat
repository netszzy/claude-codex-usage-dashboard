@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Web mode has been removed. Starting the floating desktop dashboard...
call "%~dp0start-dashboard-desktop.bat"
