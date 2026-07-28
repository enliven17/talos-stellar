@echo off
setlocal
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

echo Usage: %~nx0 {up^|down^|logs^|reset}
exit /b 1
