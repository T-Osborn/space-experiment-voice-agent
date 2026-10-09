@echo off
setlocal
rem T selected Baidu short-text voice per=4100 on 2026-10-09.
set "VOICE_PS=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if not exist "%VOICE_PS%" set "VOICE_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%VOICE_PS%" -NoProfile -File "%~dp0web-voice-agent\start-voice.ps1" -Port 8100 -Provider baidu -BaiduTtsService short_text -BaiduVoiceId 4100
pause
endlocal



