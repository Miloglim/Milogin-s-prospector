@echo off
set NODE_OPTIONS=
cd /d "%~dp0"
call npm run dev
if errorlevel 1 pause
