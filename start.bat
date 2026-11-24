@echo off
chcp 65001 >nul
set NODE_OPTIONS=
cd /d "%~dp0"
call powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\ensure-center.ps1"
if errorlevel 1 (
  echo [start] Center is not ready. Fix the error above before starting the app.
  pause
  exit /b 1
)
call npm run dev
if errorlevel 1 pause
