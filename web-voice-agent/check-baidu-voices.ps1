[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$probePath = Join-Path $PSScriptRoot 'scripts\inspect-baidu-voices.js'
$bundledNode = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $nodePath = $bundledNode }
elseif ($nodeCommand) { $nodePath = $nodeCommand.Source }
else { throw 'Node.js 24 was not found.' }
$nodeVersion = (& $nodePath -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -ne 24) { throw 'Node.js 24 is required.' }
if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) { throw 'The voice query script was not found.' }
if ($CheckOnly) {
    [pscustomobject]@{
        node_version = $nodeVersion
        query_script_present = $true
        credential_input = 'local_hidden_prompt'
        reads_env_file = $false
        cloud_requests_made = $false
        starts_agent = $false
    } | ConvertTo-Json
    return
}

Write-Host 'Baidu voice query - read-only account check'
Write-Host 'Enter the two application credentials here, not in the chat.'
Write-Host 'Only authentication and the existing cloned-voice list will be requested from Baidu.'
Write-Host 'This does not create/delete voices, upload recordings, synthesize speech or start the agent.'
Write-Host 'The result contains only safe status fields and voice names/IDs; no credentials are saved.'
Write-Host 'Ordinary voice selection cannot be determined from credentials alone.'
Write-Host 'Press Enter without a key to exit without any request.'

$secureKey = $null
$secureSecret = $null
$keyPointer = [IntPtr]::Zero
$secretPointer = [IntPtr]::Zero
$plainKey = $null
$plainSecret = $null
$queryInfo = $null
$queryProcess = $null
try {
    $secureKey = Read-Host 'BAIDU_API_KEY (hidden)' -AsSecureString
    if ($secureKey.Length -eq 0) { Write-Host 'Cancelled. No request made.'; return }
    $secureSecret = Read-Host 'BAIDU_SECRET_KEY (hidden)' -AsSecureString
    if ($secureSecret.Length -eq 0) { Write-Host 'Cancelled. No request made.'; return }
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
    if ([string]::IsNullOrWhiteSpace($plainKey) -or [string]::IsNullOrWhiteSpace($plainSecret) -or $plainKey -match '\s' -or $plainSecret -match '\s') {
        throw 'A credential is empty or contains whitespace. Run the query again.'
    }
    $queryInfo = New-Object System.Diagnostics.ProcessStartInfo
    $queryInfo.FileName = $nodePath
    $queryInfo.Arguments = '"' + $probePath + '"'
    $queryInfo.WorkingDirectory = $PSScriptRoot
    $queryInfo.UseShellExecute = $false
    $queryInfo.CreateNoWindow = $true
    $queryInfo.EnvironmentVariables['BAIDU_API_KEY'] = $plainKey
    $queryInfo.EnvironmentVariables['BAIDU_SECRET_KEY'] = $plainSecret
    $queryInfo.EnvironmentVariables.Remove('OPENAI_API_KEY')
    $queryInfo.EnvironmentVariables.Remove('SEMANTIC_API_KEY')
    $queryProcess = [System.Diagnostics.Process]::Start($queryInfo)
    $queryInfo.EnvironmentVariables.Remove('BAIDU_API_KEY')
    $queryInfo.EnvironmentVariables.Remove('BAIDU_SECRET_KEY')
    $plainKey = $null
    $plainSecret = $null
    $queryProcess.WaitForExit()
    if ($queryProcess.ExitCode -ne 0) { Write-Host 'Query incomplete. The safe result above explains what was checked.' }
} finally {
    if ($queryInfo) {
        $queryInfo.EnvironmentVariables.Remove('BAIDU_API_KEY')
        $queryInfo.EnvironmentVariables.Remove('BAIDU_SECRET_KEY')
    }
    $plainKey = $null
    $plainSecret = $null
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    if ($secureKey) { $secureKey.Dispose() }
    if ($secureSecret) { $secureSecret.Dispose() }
    if ($queryProcess) {
        # This handle belongs only to this invocation; existing servers are untouched.
        if (-not $queryProcess.HasExited) { $queryProcess.Kill(); $queryProcess.WaitForExit() }
        $queryProcess.Dispose()
    }
}
