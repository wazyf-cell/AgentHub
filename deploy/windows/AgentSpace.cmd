@echo off
setlocal
set SCRIPT_DIR=%~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%Start-AgentSpace.ps1" %*
if errorlevel 1 (
  echo.
  echo AgentSpace launcher failed. Check the error message above.
  pause
)
endlocal
