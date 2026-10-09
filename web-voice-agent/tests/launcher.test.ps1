# Local process/configuration tests only. No ASR or TTS request is made.
param([string]$LauncherPowerShell = '')
$ErrorActionPreference = 'Stop'
$launcherShellPath = if ($LauncherPowerShell) { [IO.Path]::GetFullPath($LauncherPowerShell) } else { (Get-Process -Id $PID).Path }
if (-not (Test-Path -LiteralPath $launcherShellPath -PathType Leaf)) { throw 'Launcher PowerShell executable not found.' }
$projectRoot = Split-Path $PSScriptRoot -Parent
$launcherPath = Join-Path $projectRoot 'start-voice.ps1'
$envPath = Join-Path $projectRoot '.env'
$envFileExisted = Test-Path -LiteralPath $envPath
$originalKeys = @{}
foreach ($keyName in @('OPENAI_API_KEY', 'BAIDU_API_KEY', 'BAIDU_SECRET_KEY')) {
    $originalKeys[$keyName] = [Environment]::GetEnvironmentVariable($keyName, 'Process')
}
$fakeKey = 'launcher-test-only-not-a-real-credential'
$fakeSecret = 'launcher-test-only-not-a-real-secret'
$cases = @(
    @{ Provider = 'openai'; ExtraArgs = ''; Service = ''; Voice = 0 },
    @{ Provider = 'baidu'; ExtraArgs = ' -BaiduTtsService short_text -BaiduVoiceId 4100'; Service = 'short_text'; Voice = 4100 },
    @{ Provider = 'baidu'; ExtraArgs = ' -BaiduTtsService clone -BaiduVoiceId 100001'; Service = 'clone'; Voice = 100001 }
)

foreach ($case in $cases) {
    $portReservation = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $portReservation.Start()
    $testPort = $portReservation.LocalEndpoint.Port
    $portReservation.Stop()
    if ($testPort -gt 65525) { throw 'Test port is outside the launcher range; rerun the test.' }

    $testInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $testInfo.FileName = $launcherShellPath
    $testInfo.Arguments = '-NoProfile -File "' + $launcherPath + '" -Port ' + $testPort + ' -Provider ' + $case.Provider + $case.ExtraArgs
    $testInfo.UseShellExecute = $false
    $testInfo.CreateNoWindow = $true
    $testInfo.RedirectStandardOutput = $true
    $testInfo.RedirectStandardError = $true
    $testInfo.EnvironmentVariables['OPENAI_API_KEY'] = $fakeKey
    $testInfo.EnvironmentVariables['BAIDU_API_KEY'] = $fakeKey
    $testInfo.EnvironmentVariables['BAIDU_SECRET_KEY'] = $fakeSecret
    # Simulate an old terminal carrying mock-provider configuration.
    $testInfo.EnvironmentVariables['ASR_PROVIDER'] = 'generic_http'
    $testInfo.EnvironmentVariables['TTS_PROVIDER'] = 'generic_http'
    $testInfo.EnvironmentVariables['RECORD_STORAGE'] = 'memory'
    $testInfo.EnvironmentVariables['ASR_UPSTREAM_URL'] = 'http://127.0.0.1:1/'
    $testInfo.EnvironmentVariables['TTS_UPSTREAM_URL'] = 'http://127.0.0.1:1/'
    $testInfo.EnvironmentVariables['APP_ENV'] = 'production'
    $testInfo.EnvironmentVariables['PUBLIC_ORIGIN'] = 'https://stale-test-only.example'
    $testInfo.EnvironmentVariables['DEPLOY_ACCESS_TOKEN'] = 'old-test-only-access-token-not-real'

    $testProcess = $null
    try {
        $testProcess = [System.Diagnostics.Process]::Start($testInfo)
        $stdoutTask = $testProcess.StandardOutput.ReadToEndAsync()
        $stderrTask = $testProcess.StandardError.ReadToEndAsync()
        $config = $null
        $testWebSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
        for ($attempt = 0; $attempt -lt 50; $attempt++) {
            if ($testProcess.HasExited) { throw 'Launcher exited before the local server became ready.' }
            try {
                Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$testPort/api/access" -ContentType 'application/json' -Headers @{'X-Voice-Agent-Request'='1'} -Body '{}' -WebSession $testWebSession -TimeoutSec 1 | Out-Null
                $config = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/api/voice/config" -WebSession $testWebSession -TimeoutSec 1
                break
            } catch { Start-Sleep -Milliseconds 100 }
        }
        if (-not $config) { throw 'Local server did not start within the test deadline.' }
        if ($config.asr.upstream_provider -ne $case.Provider -or $config.tts.upstream_provider -ne $case.Provider) {
            throw 'Launcher did not select the intended provider.'
        }
        if (-not $config.asr.configured -or -not $config.tts.configured) {
            throw 'The temporary credentials were not passed to the child server.'
        }
        if ($case.Provider -eq 'baidu') {
            if ($config.asr.input -ne 'audio/pcm;rate=16000' -or $config.tts.service -ne $case.Service -or $config.tts.voice_id -ne $case.Voice) {
                throw 'Baidu audio format or voice configuration was not passed correctly.'
            }
            if ($case.Voice -eq 4100 -and $config.tts.target_voice -notmatch '4100') {
                throw 'The selected voice name was not passed to the child server.'
            }
        }
        $publicConfig = $config | ConvertTo-Json -Depth 10
        if ($publicConfig.Contains($fakeKey) -or $publicConfig.Contains($fakeSecret)) { throw 'Public configuration exposed a credential.' }
        $bindings = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $testPort })
        if ($bindings.Count -ne 1 -or $bindings[0].Address.ToString() -ne '127.0.0.1') {
            throw 'Launcher did not restrict the server to loopback.'
        }
        foreach ($keyName in $originalKeys.Keys) {
            if ([Environment]::GetEnvironmentVariable($keyName, 'Process') -cne $originalKeys[$keyName]) { throw 'Parent environment changed.' }
        }
        if ((Test-Path -LiteralPath $envPath) -ne $envFileExisted) { throw 'Launcher unexpectedly wrote an .env file.' }
    } finally {
        if ($testProcess) {
            # This process and its descendants were created only by this test.
            if (-not $testProcess.HasExited) { $testProcess.Kill($true) }
            $testProcess.WaitForExit()
            $capturedOutput = $stdoutTask.GetAwaiter().GetResult() + $stderrTask.GetAwaiter().GetResult()
            $testProcess.Dispose()
            if ($capturedOutput.Contains($fakeKey) -or $capturedOutput.Contains($fakeSecret)) { throw 'Launcher printed a credential.' }
        }
    }
    $remainingBindings = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $testPort })
    if ($remainingBindings.Count -ne 0) { throw 'The temporary test server was not stopped.' }
    Write-Output ("PASS: " + $case.Provider + " " + $case.Service + " startup, loopback, private credentials, unchanged parent environment, no key file, cleanup. No cloud requests.")
}
