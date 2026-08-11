@echo off
setlocal
cd /d %~dp0

where npm >nul 2>nul
if errorlevel 1 (
  echo [Agent TUI Manager] npm was not found. Install Node.js and try again.
  pause
  exit /b 1
)

if not exist node_modules\electron\dist\electron.exe (
  echo [Agent TUI Manager] Installing dependencies through proxy 127.0.0.1:7897...
  set HTTP_PROXY=http://127.0.0.1:7897
  set HTTPS_PROXY=http://127.0.0.1:7897
  set npm_config_proxy=http://127.0.0.1:7897
  set npm_config_https_proxy=http://127.0.0.1:7897
  call npm install
  if errorlevel 1 (
    echo [Agent TUI Manager] Dependency installation failed.
    pause
    exit /b 1
  )
)

call npm run dev
if errorlevel 1 (
  echo [Agent TUI Manager] Failed to start.
  pause
  exit /b 1
)
