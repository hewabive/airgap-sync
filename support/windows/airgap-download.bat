@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "AIRGAP_SYNC_EXIT_CODE=0"

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
  call :run git pull --ff-only
  if errorlevel 1 (
    set "AIRGAP_SYNC_EXIT_CODE=!errorlevel!"
    goto end
  )
) else (
  echo [airgap-sync] Git checkout not found; skipping git pull.
)

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
