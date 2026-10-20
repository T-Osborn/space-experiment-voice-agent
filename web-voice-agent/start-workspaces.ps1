[CmdletBinding()]
param(
  [string]$BackendUrl = 'http://127.0.0.1:8100/',
  [ValidateRange(1024,65535)][int]$DemoPort = 8120,
  [ValidateRange(1024,65535)][int]$AdminPort = 8110,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$targetUrl = [Uri]$BackendUrl
if ($targetUrl.Scheme -ne 'http' -or $targetUrl.Host -notin @('127.0.0.1','localhost','[::1]') -or $targetUrl.UserInfo -or $targetUrl.AbsolutePath -ne '/' -or $targetUrl.Query -or $targetUrl.Fragment) { throw 'LOCAL_AGENT_URL_INVALID' }
if ($DemoPort -eq $AdminPort -or $targetUrl.Port -in @($DemoPort, $AdminPort)) { throw 'WORKSPACE_PORTS_MUST_DIFFER' }
$bundledNode = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$installedNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
$nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($installedNode) { $installedNode.Source } else { throw 'Install Node.js 24 first.' }
if ([int]((& $nodePath -p 'process.versions.node').Trim().Split('.')[0]) -ne 24) { throw 'Node.js 24 is required.' }
$listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
foreach ($workspacePort in @($DemoPort, $AdminPort)) { if ($workspacePort -in $listeners) { throw ('WORKSPACE_PORT_IN_USE: ' + $workspacePort) } }
if ($CheckOnly) {
  [pscustomobject]@{ demo_url = "http://127.0.0.1:$DemoPort/"; admin_url = "http://127.0.0.1:$AdminPort/"; backend_url = $targetUrl.AbsoluteUri; cloud_requests = $false; key_required = $false } | ConvertTo-Json
  return
}
$workspaceProcesses = @()
try {
  foreach ($entry in @('frontend-index.js','admin-index.js')) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $nodePath
    $info.Arguments = '"' + (Join-Path $PSScriptRoot ('server/' + $entry)) + '"'
    $info.WorkingDirectory = $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.EnvironmentVariables['VOICE_AGENT_URL'] = $targetUrl.AbsoluteUri
    $info.EnvironmentVariables['DEMO_PORT'] = [string]$DemoPort
    $info.EnvironmentVariables['ADMIN_PORT'] = [string]$AdminPort
    $info.EnvironmentVariables['DEMO_FRONTEND_URL'] = "http://127.0.0.1:$DemoPort/"
    foreach ($credentialName in @('OPENAI_API_KEY','BAIDU_API_KEY','BAIDU_SECRET_KEY','ASR_API_KEY','TTS_API_KEY','SEMANTIC_API_KEY','DEPLOY_ACCESS_TOKEN')) { $info.EnvironmentVariables.Remove($credentialName) }
    $workspaceProcesses += [Diagnostics.Process]::Start($info)
  }
  Write-Host "Demo frontend: http://127.0.0.1:$DemoPort/"
  Write-Host "Management console: http://127.0.0.1:$AdminPort/"
  Write-Host "Agent backend: $($targetUrl.AbsoluteUri)"
  Write-Host 'Keep the Baidu voice service running separately. This window never requests speech keys.'
  Write-Host 'Ctrl+C stops only these two workspace services, not your existing Agent backend.'
  while ($true) {
    if (@($workspaceProcesses | Where-Object { $_.HasExited }).Count) { throw 'A_WORKSPACE_SERVICE_STOPPED' }
    Start-Sleep -Milliseconds 500
  }
} finally {
  foreach ($workspaceProcess in $workspaceProcesses) {
    if (-not $workspaceProcess.HasExited) { $workspaceProcess.Kill(); $workspaceProcess.WaitForExit() }
    $workspaceProcess.Dispose()
  }
}
