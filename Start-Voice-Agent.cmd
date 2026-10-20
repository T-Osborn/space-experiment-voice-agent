@echo off
setlocal
set "VOICE_PS=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if not exist "%VOICE_PS%" set "VOICE_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
rem Process-only policy override; machine and user execution policies are not changed.
"%VOICE_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0web-voice-agent\start-app.ps1"
pause
endlocal
