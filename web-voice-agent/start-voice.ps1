[CmdletBinding()]
param(
    [ValidateRange(1024, 65525)]
    [int]$Port = 8088,
    [ValidateSet('openai', 'baidu')]
    [string]$Provider = 'openai',
    [ValidateSet('', 'short_text', 'clone')]
    [string]$BaiduTtsService = '',
    [string]$BaiduVoiceId = '',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$serverPath = Join-Path $projectRoot 'server\index.js'
$bundledNode = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    $nodePath = $bundledNode
} elseif ($nodeCommand) {
    $nodePath = $nodeCommand.Source
} else {
    throw 'Node.js was not found. Install Node.js 24, then run this launcher again.'
}

$nodeVersion = (& $nodePath -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -ne 24) {
    throw 'This project is currently tested with Node.js 24.'
}
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw 'The project server file was not found. Keep the launcher with the project files.'
}

$occupiedPorts = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
$selectedPort = $Port
while ($occupiedPorts -contains $selectedPort -and $selectedPort -lt ($Port + 10)) {
    $selectedPort++
}
if ($occupiedPorts -contains $selectedPort) {
    throw 'All candidate ports are in use. Run start-voice.ps1 with a different -Port value.'
}
$voiceUrl = "http://127.0.0.1:$selectedPort/"
$hasEnvironmentKey = if ($Provider -eq 'baidu') { -not [string]::IsNullOrWhiteSpace($env:BAIDU_API_KEY) } else { -not [string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY) }
$hasEnvironmentSecret = -not [string]::IsNullOrWhiteSpace($env:BAIDU_SECRET_KEY)
$selectedService = if ($BaiduTtsService) { $BaiduTtsService } elseif ($env:BAIDU_TTS_SERVICE) { $env:BAIDU_TTS_SERVICE } else { 'short_text' }
$selectedVoice = if ($BaiduVoiceId) { $BaiduVoiceId } elseif ($env:BAIDU_TTS_VOICE) { $env:BAIDU_TTS_VOICE } elseif ($selectedService -eq 'short_text') { '4100' } else { '' }
$voiceNumber = 0L
$validBaiduVoice = [long]::TryParse($selectedVoice, [ref]$voiceNumber) -and $voiceNumber -ge 0 -and $voiceNumber -le 9007199254740991 -and ($selectedService -ne 'clone' -or $voiceNumber -gt 0)
$hasCredentials = $hasEnvironmentKey -and ($Provider -ne 'baidu' -or $hasEnvironmentSecret)

if ($CheckOnly) {
    [pscustomobject]@{
        node_version = $nodeVersion
        server_file_present = $true
        provider = $Provider
        key_present_in_environment = $hasCredentials
        requires_local_key_entry = -not $hasCredentials
        tts_service = if ($Provider -eq 'baidu') { $selectedService } else { 'openai' }
        voice_id = if ($Provider -eq 'baidu' -and $validBaiduVoice) { $voiceNumber } else { $null }
        voice_configuration_valid = $Provider -ne 'baidu' -or ($validBaiduVoice -and $selectedService -in @('short_text', 'clone'))
        selected_url = $voiceUrl
        real_service_verified = $false
    } | ConvertTo-Json
    return
}

Write-Host 'Voice Agent - local configuration and startup'
if ($Provider -eq 'baidu') {
    if (-not $validBaiduVoice -or $selectedService -notin @('short_text', 'clone')) {
        throw 'Baidu voice configuration is incomplete. Set -BaiduTtsService and -BaiduVoiceId. See docs/19-baidu-voice-setup.md.'
    }
    Write-Host "ASR and TTS provider: Baidu. Voice service: $selectedService. Voice ID: $selectedVoice."
    Write-Host 'After you record, audio and reply text are sent to Baidu for transcription and speech.'
} else {
    Write-Host 'ASR and TTS provider: OpenAI. This launcher uses the official API endpoints.'
    Write-Host 'After you record, audio and reply text are sent to OpenAI for transcription and speech.'
}
Write-Host 'Your API account may be charged. Startup itself does not call the cloud API.'
Write-Host 'Enter the API key only at the hidden prompt below, never in the chat.'
Write-Host 'The launcher does not save a key file or change system environment variables.'
Write-Host 'No key yet? Press Enter to exit and see the configuration guide.'

$secureKey = $null
$keyPointer = [IntPtr]::Zero
$plainKey = $null
$plainBaiduSecret = $null
$secureBaiduSecret = $null
$secretPointer = [IntPtr]::Zero
$startInfo = $null
$voiceProcess = $null
try {
    if ($hasEnvironmentKey) {
        $plainKey = if ($Provider -eq 'baidu') { $env:BAIDU_API_KEY.Trim() } else { $env:OPENAI_API_KEY.Trim() }
        Write-Host 'Using the API key already set in this terminal environment.'
    } else {
        $keyPrompt = if ($Provider -eq 'baidu') { 'BAIDU_API_KEY (hidden)' } else { 'OPENAI_API_KEY (hidden)' }
        $secureKey = Read-Host $keyPrompt -AsSecureString
        if ($secureKey.Length -eq 0) {
            Write-Host 'No key entered. Nothing was started or sent.'
            Write-Host $(if ($Provider -eq 'baidu') { 'Guide: docs/19-baidu-voice-setup.md' } else { 'Guide: docs/17-real-voice-setup.md' })
            return
        }
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey -match '\s') {
        throw 'The key is empty or contains whitespace. Run the launcher again.'
    }

    if ($Provider -eq 'baidu') {
        if ($hasEnvironmentSecret) {
            $plainBaiduSecret = $env:BAIDU_SECRET_KEY.Trim()
        } else {
            $secureBaiduSecret = Read-Host 'BAIDU_SECRET_KEY (hidden)' -AsSecureString
            if ($secureBaiduSecret.Length -eq 0) {
                Write-Host 'No Secret Key entered. Nothing was started or sent.'
                return
            }
            $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureBaiduSecret)
            $plainBaiduSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
        }
        if ([string]::IsNullOrWhiteSpace($plainBaiduSecret) -or $plainBaiduSecret -match '\s') {
            throw 'The Secret Key is empty or contains whitespace. Run the launcher again.'
        }
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = '"' + $serverPath + '"'
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    # Only the new server receives these values. Existing .env files are not edited.
    $startInfo.EnvironmentVariables['PORT'] = [string]$selectedPort
    $startInfo.EnvironmentVariables['HOST'] = '127.0.0.1'
    $startInfo.EnvironmentVariables['APP_ENV'] = 'development'
    $startInfo.EnvironmentVariables.Remove('PUBLIC_ORIGIN')
    $startInfo.EnvironmentVariables.Remove('DEPLOY_ACCESS_TOKEN')
    $startInfo.EnvironmentVariables['ASR_PROVIDER'] = $Provider
    $startInfo.EnvironmentVariables['TTS_PROVIDER'] = $Provider
    if ($Provider -eq 'baidu') {
        $startInfo.EnvironmentVariables.Remove('OPENAI_API_KEY')
        $startInfo.EnvironmentVariables['BAIDU_API_KEY'] = $plainKey
        $startInfo.EnvironmentVariables['BAIDU_SECRET_KEY'] = $plainBaiduSecret
        $startInfo.EnvironmentVariables['BAIDU_TTS_SERVICE'] = $selectedService
        $startInfo.EnvironmentVariables['BAIDU_TTS_VOICE'] = $selectedVoice
        $startInfo.EnvironmentVariables['BAIDU_TTS_VOICE_NAME'] = if ($selectedService -eq 'short_text' -and $selectedVoice -eq '4100') { '度小雯（per 4100）' } else { '' }
        $startInfo.EnvironmentVariables['ASR_UPSTREAM_URL'] = 'https://vop.baidu.com/server_api'
        $startInfo.EnvironmentVariables['TTS_UPSTREAM_URL'] = if ($selectedService -eq 'clone') { 'https://aip.baidubce.com/rest/2.0/speech/publiccloudspeech/v1/voice/clone/tts' } else { 'https://tsn.baidu.com/text2audio' }
    } else {
        $startInfo.EnvironmentVariables['OPENAI_API_KEY'] = $plainKey
        $startInfo.EnvironmentVariables['ASR_UPSTREAM_URL'] = 'https://api.openai.com/v1/audio/transcriptions'
        $startInfo.EnvironmentVariables['TTS_UPSTREAM_URL'] = 'https://api.openai.com/v1/audio/speech'
        $startInfo.EnvironmentVariables['OPENAI_ASR_MODEL'] = 'gpt-4o-mini-transcribe'
        $startInfo.EnvironmentVariables['OPENAI_TTS_MODEL'] = 'gpt-4o-mini-tts'
        $startInfo.EnvironmentVariables['OPENAI_TTS_VOICE'] = 'sage'
        $startInfo.EnvironmentVariables['OPENAI_TTS_SPEED'] = '0.95'
    }

    $voiceProcess = [System.Diagnostics.Process]::Start($startInfo)
    $startInfo.EnvironmentVariables.Remove('OPENAI_API_KEY')
    $startInfo.EnvironmentVariables.Remove('BAIDU_API_KEY')
    $startInfo.EnvironmentVariables.Remove('BAIDU_SECRET_KEY')
    $plainKey = $null
    $plainBaiduSecret = $null
    Write-Host "Open the address printed by this server: $voiceUrl"
    Write-Host 'Keep this window open while testing. Ctrl+C stops this server.'
    Write-Host 'Key presence does not prove validity, balance, network access, or recognition quality.'
    $voiceProcess.WaitForExit()
    if ($voiceProcess.ExitCode -ne 0) {
        throw 'The server stopped with an error. Review the server message above.'
    }
} finally {
    if ($startInfo) {
        $startInfo.EnvironmentVariables.Remove('OPENAI_API_KEY')
        $startInfo.EnvironmentVariables.Remove('BAIDU_API_KEY')
        $startInfo.EnvironmentVariables.Remove('BAIDU_SECRET_KEY')
    }
    $plainKey = $null
    $plainBaiduSecret = $null
    if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    if ($secureBaiduSecret) { $secureBaiduSecret.Dispose() }
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    if ($secureKey) { $secureKey.Dispose() }
    # Never stop an existing server; this handle belongs only to this invocation.
    if ($voiceProcess) {
        if (-not $voiceProcess.HasExited) { $voiceProcess.Kill(); $voiceProcess.WaitForExit() }
        $voiceProcess.Dispose()
    }
}
