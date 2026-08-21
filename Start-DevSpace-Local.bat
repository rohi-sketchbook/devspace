@echo off
setlocal
cd /d "%~dp0"

echo === DevSpace local upstream-main build ===
echo Source: Waishnav/devspace main + Rohi local tools
set "MINIMUM_UPSTREAM_COMMIT=d9855aa5e115d25417ac84f0af807968a3dae063"

for /f %%I in ('git rev-parse HEAD 2^>nul') do set "CURRENT_COMMIT=%%I"
if not defined CURRENT_COMMIT (
  echo ERROR: Unable to read the current Git commit.
  exit /b 1
)
echo Current commit: %CURRENT_COMMIT%
git merge-base --is-ancestor "%MINIMUM_UPSTREAM_COMMIT%" HEAD >nul 2>&1
if errorlevel 1 (
  echo ERROR: This checkout is not based on the validated upstream main baseline.
  exit /b 1
)
echo Upstream baseline check: OK

if not exist "dist\cli.js" (
  echo ERROR: dist\cli.js was not found. Run npm run build first.
  exit /b 1
)

set "DEVSPACE_ARTIFACTS=1"
set "DEVSPACE_SUBAGENTS=1"
set "DEVSPACE_ALLOWED_ROOTS=H:\codexapp,C:\Users\rohi\.devspace\worktrees"
set "DEVSPACE_WORKTREE_ROOT=H:\codexapp\worktrees"
echo Native artifact download: ENABLED
echo Subagents: ENABLED ^(daemon starts on demand^)
echo Allowed roots: %DEVSPACE_ALLOWED_ROOTS%
echo Worktree root: %DEVSPACE_WORKTREE_ROOT%
echo Windows artifact runtime: local koffi 3.1.2
echo Using existing %%USERPROFILE%%\.devspace\config.json and auth.json.
echo.

node "dist\cli.js" serve
exit /b %ERRORLEVEL%
