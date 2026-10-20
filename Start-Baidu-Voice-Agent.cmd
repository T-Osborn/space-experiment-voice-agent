@echo off
setlocal
rem T selected Baidu short-text voice per=5 for 2.0 on 2026-10-15.
set "VOICE_PS=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if not exist "%VOICE_PS%" set "VOICE_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
rem Process-only policy override; machine and user execution policies are not changed.
"%VOICE_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0web-voice-agent\start-voice.ps1" -Port 8100 -Provider baidu -BaiduTtsService short_text -BaiduVoiceId 5
pause
endlocal



