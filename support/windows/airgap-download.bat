@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "AIRGAP_SYNC_EXIT_CODE=0"
set "AIRGAP_SYNC_NEEDS_BUILD=0"

call :find_workspace
if errorlevel 1 (
  set "AIRGAP_SYNC_EXIT_CODE=!errorlevel!"
  goto end
)

cd /d "%AIRGAP_SYNC_WORKSPACE%"
if errorlevel 1 (
  echo [ERROR] Could not enter workspace "%AIRGAP_SYNC_WORKSPACE%".
  set "AIRGAP_SYNC_EXIT_CODE=!errorlevel!"
  goto end
)

if exist ".git" (
  call :git_pull
  if errorlevel 1 (
    set "AIRGAP_SYNC_EXIT_CODE=!errorlevel!"
    goto end
  )
) else (
  echo [airgap-sync] Git checkout not found; skipping git pull.
)

if not exist "node_modules" (
  echo [airgap-sync] node_modules not found; dependencies will be installed.
  set "AIRGAP_SYNC_NEEDS_BUILD=1"
)

if not exist "dist\cli.cjs" (
  echo [airgap-sync] Built CLI not found; project will be built.
  set "AIRGAP_SYNC_NEEDS_BUILD=1"
)

if "!AIRGAP_SYNC_NEEDS_BUILD!"=="1" (
  call :run npm install
  if errorlevel 1 (
    set "AIRGAP_SYNC_EXIT_CODE=!errorlevel!"
    goto end
  )

  call :run npm run build
  if errorlevel 1 (
    set "AIRGAP_SYNC_EXIT_CODE=!errorlevel!"
    goto end
  )
) else (
  echo [airgap-sync] Application is already up to date; skipping npm install and build.
)

call :run_cli download %*
if errorlevel 1 (
  set "AIRGAP_SYNC_EXIT_CODE=!errorlevel!"
  goto end
)

echo.
echo [OK] Download updates completed.
goto end

:find_workspace
if defined AIRGAP_SYNC_WORKSPACE (
  call :validate_workspace "%AIRGAP_SYNC_WORKSPACE%"
  exit /b %errorlevel%
)

set "AIRGAP_SYNC_FOLDER=airgap-sync"
if defined AIRGAP_SYNC_WORKSPACE_FOLDER set "AIRGAP_SYNC_FOLDER=%AIRGAP_SYNC_WORKSPACE_FOLDER%"

echo [airgap-sync] Searching removable drives for %AIRGAP_SYNC_FOLDER%...
for %%D in (D E F G H I J K L M N O P Q R S T U V W X Y Z) do (
  if exist "%%D:\%AIRGAP_SYNC_FOLDER%\package.json" (
    call :validate_workspace "%%D:\%AIRGAP_SYNC_FOLDER%"
    exit /b !errorlevel!
  )
)

echo [ERROR] Workspace folder was not found.
echo Set AIRGAP_SYNC_WORKSPACE to the full workspace path if it is not X:\%AIRGAP_SYNC_FOLDER%.
exit /b 1

:validate_workspace
set "AIRGAP_SYNC_WORKSPACE=%~1"
if not exist "%AIRGAP_SYNC_WORKSPACE%\package.json" (
  echo [ERROR] package.json was not found in "%AIRGAP_SYNC_WORKSPACE%".
  exit /b 1
)
echo [airgap-sync] Workspace: %AIRGAP_SYNC_WORKSPACE%
exit /b 0

:run
echo.
echo [airgap-sync] %*
call %*
if errorlevel 1 (
  echo.
  echo [ERROR] Command failed with exit code %errorlevel%: %*
  exit /b %errorlevel%
)
exit /b 0

:git_pull
echo.
echo [airgap-sync] git pull --ff-only
set "AIRGAP_SYNC_PULL_LOG=%TEMP%\airgap-sync-pull-%RANDOM%-%RANDOM%.log"
git pull --ff-only > "!AIRGAP_SYNC_PULL_LOG!" 2>&1
set "AIRGAP_SYNC_PULL_CODE=!errorlevel!"
type "!AIRGAP_SYNC_PULL_LOG!"

if not "!AIRGAP_SYNC_PULL_CODE!"=="0" (
  del "!AIRGAP_SYNC_PULL_LOG!" >nul 2>nul
  echo.
  echo [ERROR] Command failed with exit code !AIRGAP_SYNC_PULL_CODE!: git pull --ff-only
  exit /b !AIRGAP_SYNC_PULL_CODE!
)

findstr /C:"Already up to date." /C:"Already up-to-date." "!AIRGAP_SYNC_PULL_LOG!" >nul
if errorlevel 1 (
  set "AIRGAP_SYNC_NEEDS_BUILD=1"
  echo [airgap-sync] Git updates detected; dependencies and build will be refreshed.
) else (
  echo [airgap-sync] Git already up to date.
)

del "!AIRGAP_SYNC_PULL_LOG!" >nul 2>nul
exit /b 0

:run_cli
if not exist "%AIRGAP_SYNC_WORKSPACE%\dist\cli.cjs" (
  echo [ERROR] Built CLI was not found at "%AIRGAP_SYNC_WORKSPACE%\dist\cli.cjs".
  exit /b 1
)
echo.
echo [airgap-sync] node dist\cli.cjs %*
node "%AIRGAP_SYNC_WORKSPACE%\dist\cli.cjs" %*
if errorlevel 1 (
  echo.
  echo [ERROR] airgap-sync failed with exit code %errorlevel%.
  exit /b %errorlevel%
)
exit /b 0

:end
echo.
echo Press any key to exit...
pause >nul
exit /b !AIRGAP_SYNC_EXIT_CODE!
