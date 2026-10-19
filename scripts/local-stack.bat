@echo off
setlocal enabledelayedexpansion
set ROOT=%~dp0..\
cd /d "%ROOT%"

if "%~1"=="" set COMMAND=up
if not "%~1"=="" set COMMAND=%~1

if /I "%COMMAND%"=="up" (
  docker compose up -d postgres mock-stellar web
  echo.
  echo Local stack is starting.
  echo - Web: http://localhost:3000
  echo - Health: http://localhost:3000/api/health
  echo - Mock Stellar: http://localhost:4010/health
  echo.
  echo Use 'docker compose --profile agent up -d prime-agent' to add the agent profile.
  exit /b 0
)

if /I "%COMMAND%"=="down" (
  docker compose down --remove-orphans
  exit /b 0
)

if /I "%COMMAND%"=="logs" (
  docker compose logs -f --tail=200
  exit /b 0
)

if /I "%COMMAND%"=="reset" (
  docker compose down -v --remove-orphans
  docker compose up -d postgres mock-stellar web
  exit /b 0
)

if /I "%COMMAND%"=="reset-data" (
  for /f "usebackq delims=" %%i in (`docker compose ps -q postgres 2^>nul`) do set POSTGRES_RUNNING=%%i
  if "!POSTGRES_RUNNING!"=="" (
    echo local-stack: the postgres service is not running.
    echo Start it first with: pnpm stack:up
    echo Use 'pnpm stack:reset' only if you want to destroy and recreate the stack volumes.
    exit /b 1
  )
  if defined TALOS_RESET_DATABASE_URL (
    set "DATABASE_URL=!TALOS_RESET_DATABASE_URL!"
  ) else if not defined DATABASE_URL (
    set "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/talos"
  )
  pnpm --dir web run db:reset-test-data %2 %3 %4 %5 %6 %7 %8 %9
  exit /b !ERRORLEVEL!
)

echo Usage: %~nx0 {up^|down^|logs^|reset^|reset-data}
exit /b 1
