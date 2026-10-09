@echo off
setlocal
set "VOICE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%VOICE_NODE%" set "VOICE_NODE=node"
"%VOICE_NODE%" "%~dp0web-voice-agent\scripts\check-readiness.js"
pause
endlocal
