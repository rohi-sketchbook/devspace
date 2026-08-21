@echo off
setlocal
chcp 65001 >nul
title DevSpace Local Status
cd /d "%~dp0"

echo ============================================================
echo DevSpace Local Status
echo Date: %date% %time%
echo ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'SilentlyContinue';" ^
  "$port = 7676;" ^
  "$configPath = Join-Path $env:USERPROFILE '.devspace\config.json';" ^
  "if (Test-Path $configPath) {" ^
  "  try {" ^
  "    $config = Get-Content -Raw $configPath | ConvertFrom-Json;" ^
  "    if ($config.port) { $port = [int]$config.port; }" ^
  "  } catch {}" ^
  "}" ^
  "if ($env:PORT -match '^\d+$') { $port = [int]$env:PORT; }" ^
  "$healthUrl = 'http://127.0.0.1:' + $port + '/healthz';" ^
  "$serverHealthy = $false;" ^
  "try {" ^
  "  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3;" ^
  "  $serverHealthy = ($health.ok -eq $true -and $health.name -eq 'devspace');" ^
  "} catch {}" ^
  "Write-Host '--- DevSpace server ---';" ^
  "Write-Host ('Health URL: ' + $healthUrl);" ^
  "if ($serverHealthy) {" ^
  "  Write-Host 'RUNNING - health check OK' -ForegroundColor Green;" ^
  "} else {" ^
  "  Write-Host 'STOPPED or unhealthy' -ForegroundColor Red;" ^
  "}" ^
  "if (Test-Path 'dist\cli.js') {" ^
  "  Write-Host ''; Write-Host '--- Local agent daemon ---';" ^
  "  node 'dist\cli.js' agents daemon status --json;" ^
  "}" ^
  "if ($serverHealthy) { exit 0 } else { exit 1 }"

set "RESULT=%ERRORLEVEL%"
echo.
echo ============================================================
if "%RESULT%"=="0" (
  echo RESULT: DevSpace server is running.
) else (
  echo RESULT: DevSpace server is not running.
)
echo ExitCode=%RESULT%
echo ============================================================
exit /b %RESULT%
