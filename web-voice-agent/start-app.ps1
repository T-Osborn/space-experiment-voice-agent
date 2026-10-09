[CmdletBinding()]
param([ValidateRange(1024, 65525)][int]$Port = 8100, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$bundledNode = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
$nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($nodeCommand) { $nodeCommand.Source } else { throw 'Install Node.js 24 first.' }
$nodeVersion = (& $nodePath -p 'process.versions.node').Trim()
if ([int]($nodeVersion.Split('.')[0]) -ne 24) { throw 'Node.js 24 is required.' }
$serverPath = Join-Path $PSScriptRoot 'server/index.js'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw 'Server file is missing.' }
$portsInUse = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
$selectedPort = $Port
while ($portsInUse -contains $selectedPort -and $selectedPort -lt ($Port + 10)) { $selectedPort++ }
if ($portsInUse -contains $selectedPort) { throw 'No free local port. Choose another -Port value.' }
# Escape non-ASCII JSON for native-output decoding in Windows CMD code pages.
$readinessJson = & $nodePath (Join-Path $PSScriptRoot 'scripts/check-readiness.js') --ascii
if ($LASTEXITCODE -ne 0) { throw 'Application readiness check failed.' }
$readiness = ($readinessJson -join "`n") | ConvertFrom-Json
if ($CheckOnly) {
  [pscustomobject]@{ node_version = $nodeVersion; url = "http://127.0.0.1:$selectedPort/"; local_config_present = (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env')); key_required_to_start = $false; cloud_requests = $false; voice_readiness = $readiness } | ConvertTo-Json -Depth 5
  return
}
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $nodePath
$info.Arguments = '"' + $serverPath + '"'
$info.WorkingDirectory = $PSScriptRoot
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.EnvironmentVariables['PORT'] = [string]$selectedPort
$info.EnvironmentVariables['HOST'] = '127.0.0.1'
$info.EnvironmentVariables['APP_ENV'] = 'development'
$info.EnvironmentVariables['PUBLIC_ORIGIN'] = ''
$info.EnvironmentVariables['DEPLOY_ACCESS_TOKEN'] = ''
Write-Host 'Starts the local application using web-voice-agent/.env or existing environment settings.'
Write-Host 'No keys are requested, saved, or sent by this launcher. No voice is selected automatically.'
Write-Host $readiness.message
Write-Host "Open http://127.0.0.1:$selectedPort/ and keep this window open. Ctrl+C stops this instance."
$appProcess = $null
try {
  $appProcess = [Diagnostics.Process]::Start($info)
  $appProcess.WaitForExit()
  if ($appProcess.ExitCode -ne 0) { throw 'Application startup failed. Check the message above.' }
} finally {
  if ($appProcess) {
    if (-not $appProcess.HasExited) { $appProcess.Kill(); $appProcess.WaitForExit() }
    $appProcess.Dispose()
  }
}
