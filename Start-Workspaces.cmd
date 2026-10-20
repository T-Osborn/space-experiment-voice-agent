@echo off
setlocal
set "WORKSPACE_PS=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if not exist "%WORKSPACE_PS%" set "WORKSPACE_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%WORKSPACE_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0web-voice-agent\start-workspaces.ps1" %*
pause
endlocal
