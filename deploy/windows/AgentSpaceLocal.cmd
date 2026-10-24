@echo off
setlocal
set SCRIPT_DIR=%~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%Start-AgentSpaceLocal.ps1" %*
echo.
echo AgentSpace Local launcher finished.
pause
endlocal
