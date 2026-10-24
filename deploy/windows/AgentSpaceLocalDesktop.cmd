@echo off
setlocal
set SCRIPT_DIR=%~dp0
set REPO_ROOT=%SCRIPT_DIR%..\..
pushd "%REPO_ROOT%"
npm run desktop:local:dev
if errorlevel 1 (
  echo.
  echo AgentSpace Local Desktop failed. Check the error message above.
  pause
)
popd
endlocal
