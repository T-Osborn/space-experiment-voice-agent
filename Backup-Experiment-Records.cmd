@echo off
setlocal
set "RECORD_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%RECORD_NODE%" set "RECORD_NODE=node"
"%RECORD_NODE%" "%~dp0web-voice-agent\scripts\backup-records.js"
pause
endlocal
