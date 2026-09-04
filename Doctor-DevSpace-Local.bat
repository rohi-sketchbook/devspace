@echo off
setlocal
cd /d "%~dp0"

set "MINIMUM_UPSTREAM_COMMIT=d9855aa5e115d25417ac84f0af807968a3dae063"
set "DEVSPACE_ARTIFACTS=1"
set "DEVSPACE_SUBAGENTS=1"

echo === DevSpace local Doctor ===
echo Artifact download: ENABLED
echo Subagents: ENABLED
echo Windows artifact runtime: local koffi 3.1.2
echo Rohi local MCP tools: read_image, delete_path, git_cleanup
echo NOTE: After adding, removing, or renaming MCP tools, refresh the ChatGPT app action catalog.
echo NOTE: Restarting DevSpace alone does not refresh ChatGPT-side action permissions.

if not exist "dist\cli.js" (
  echo ERROR: dist\cli.js is missing. Run npm run build first.
  exit /b 1
)

for /f %%I in ('git rev-parse HEAD 2^>nul') do set "CURRENT_COMMIT=%%I"
if not defined CURRENT_COMMIT (
  echo ERROR: Unable to read current Git commit.
  exit /b 1
)

echo Baseline commit: %MINIMUM_UPSTREAM_COMMIT%
echo Current commit : %CURRENT_COMMIT%
git merge-base --is-ancestor "%MINIMUM_UPSTREAM_COMMIT%" HEAD >nul 2>&1
if errorlevel 1 (
  echo WARNING: The validated upstream baseline is not an ancestor of this checkout.
) else (
  echo Upstream baseline check: OK
)

for /f %%I in ('node "dist\cli.js" --version') do set "DEVSPACE_VERSION=%%I"
echo DevSpace version: %DEVSPACE_VERSION%
node --version
echo.

node "dist\cli.js" doctor
exit /b %ERRORLEVEL%
