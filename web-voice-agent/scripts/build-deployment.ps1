# Creates a reproducible source deployment bundle, not a built container image.
param([switch]$Overwrite, [string]$ExportDirectory = '')
$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$distDirectory = Join-Path $projectDirectory 'dist'
$bundleVersion = (Get-Content -LiteralPath (Join-Path $projectDirectory 'web-voice-agent/package.json') -Raw | ConvertFrom-Json).version
$archivePath = Join-Path $distDirectory ("space-experiment-voice-agent-$bundleVersion.zip")
$exportPath = $null
if ($ExportDirectory) {
  $exportPath = [IO.Path]::GetFullPath((Join-Path $projectDirectory $ExportDirectory))
  if (-not $exportPath.StartsWith($projectDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Source export must remain inside the project.' }
  if (Test-Path -LiteralPath $exportPath) { throw 'Source export already exists. Choose a new directory; existing files are preserved.' }
}
if ((Test-Path -LiteralPath $archivePath) -and -not $Overwrite) { throw 'Bundle already exists. Use -Overwrite only to replace this generated deployment bundle.' }
$stagingName = 'voice-deployment-' + [Guid]::NewGuid().ToString('N')
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stagingDirectory = [IO.Path]::GetFullPath((Join-Path $tempParent $stagingName))
if (-not $stagingDirectory.StartsWith($tempParent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Staging target is outside the intended temporary directory.' }
New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
$relativeFiles = @(
  'README.md', 'FEEDBACK.md', 'RELEASE_NOTES.md', '.gitignore',
  'Start-Workspaces.cmd', 'web-voice-agent/start-workspaces.ps1', 'docs/47-演示前台与管理后台分离.md',
  'docs/48-口述UTC时间提取修复.md', 'docs/49-beta2更新与复测.md',
  'docs/44-2.0团队独立测试指南.md', 'docs/45-2.0语音测试问答表.md',
  'docs/38-SkillV2规则实现与验收.md', 'docs/39-追问衔接与强制知识检索.md', 'docs/40-旧会话版本循环修复.md',
  'web-voice-agent/config/SKILL_V2.md',
  'web-voice-agent/config/system-prompt-v2.md',
  'web-voice-agent/config/persona.md',
  'docs/41-水稻知识库更新验收.md', 'docs/42-交同事修订的水稻资料问题清单.md',
  '.github/ISSUE_TEMPLATE/team-feedback.yml', '.github/ISSUE_TEMPLATE/config.yml', 'docs/35-1.0团队试用指南.md',
  '.github/ISSUE_TEMPLATE/team-feedback-v2.yml',
  'web-voice-agent/scripts/build-deployment.ps1', 'web-voice-agent/scripts/verify-bundle.ps1', 'web-voice-agent/tests/launcher.test.ps1',
  'Start-Voice-Agent.cmd', 'web-voice-agent/start-app.ps1', 'docs/30-主框架使用说明.md',
  'Check-Voice-Readiness.cmd', 'web-voice-agent/scripts/check-readiness.js', 'docs/31-语音接入检查.md',
  'docs/32-步骤重新核对与交付说明.md', 'docs/34-百度音色4100接入.md',
  'Backup-Experiment-Records.cmd', 'web-voice-agent/scripts/backup-records.js', 'docs/33-记录长期保存与恢复说明.md',
  'Start-Baidu-Voice-Agent.cmd', 'web-voice-agent/check-baidu-voices.ps1',
  'web-voice-agent/start-voice.ps1',
  'web-voice-agent/scripts/inspect-baidu-voices.js', 'web-voice-agent/scripts/export-procedure-review.js',
  'Dockerfile', '.dockerignore', 'compose.yaml', 'docs/21-部署打包与界面验收.md', 'docs/22-流程细化与对话理解验收.md', 'docs/23-新版预览与HTTP演练验收.md', 'docs/25-水稻与生态知识扩展验收.md',
  'knowledge_base/records.json', 'knowledge_base/qa-core.json', 'knowledge_base/qa-expanded.json', 'knowledge_base/qa-rice-2026-10.json', 'knowledge_base/verified_sources.json', 'knowledge_base/project_sources.json',
  'web-voice-agent/package.json', 'web-voice-agent/README.md', 'web-voice-agent/.env.example', 'web-voice-agent/.env.deploy.example',
  'web-voice-agent/scripts/check-deployment.js', 'web-voice-agent/scripts/rehearse-demo.js', 'web-voice-agent/scripts/run-tests.js', 'web-voice-agent/scripts/demo-inputs.js', 'web-voice-agent/scripts/rehearse-http.js'
)
foreach ($directory in @('web-voice-agent/server', 'web-voice-agent/public', 'web-voice-agent/config', 'web-voice-agent/admin')) {
  $relativeFiles += Get-ChildItem -LiteralPath (Join-Path $projectDirectory $directory) -File |
    Where-Object { $_.Extension -in @('.js','.css','.html','.json') } |
    ForEach-Object { $directory + '/' + $_.Name }
}
$relativeFiles += Get-ChildItem -LiteralPath (Join-Path $projectDirectory 'web-voice-agent/tests') -File -Filter '*.test.js' | Where-Object { $_.Name -notlike '*.private.test.js' } | ForEach-Object { 'web-voice-agent/tests/' + $_.Name }
try {
  foreach ($relative in $relativeFiles) {
    $source = [IO.Path]::GetFullPath((Join-Path $projectDirectory $relative))
    $destination = [IO.Path]::GetFullPath((Join-Path $stagingDirectory $relative))
    if (-not $source.StartsWith($projectDirectory + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $destination.StartsWith($stagingDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Bundle member escapes its validated root.' }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('Missing bundle file: ' + $relative) }
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }
  New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
  Compress-Archive -Path (Join-Path $stagingDirectory '*') -DestinationPath $archivePath -Force
  $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $members = @($archive.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\','/') })
    foreach ($member in $members) {
      if ($member -notin $relativeFiles) { throw ('Unexpected bundle member: ' + $member) }
    }
    foreach ($relative in $relativeFiles) { if ($relative -notin $members) { throw ('Missing archive member: ' + $relative) } }
  } finally { $archive.Dispose() }
  if ($exportPath) {
    New-Item -ItemType Directory -Path $exportPath | Out-Null
    foreach ($relative in $relativeFiles) {
      $exportMember = [IO.Path]::GetFullPath((Join-Path $exportPath $relative))
      if (-not $exportMember.StartsWith($exportPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Source export member escapes its root.' }
      New-Item -ItemType Directory -Path (Split-Path -Parent $exportMember) -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $stagingDirectory $relative) -Destination $exportMember
    }
  }
  [pscustomobject]@{ archive = $archivePath; source_export = $exportPath; file_count = $relativeFiles.Count; sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash; real_credentials_included = $false; original_candidate_documents_included = $false; container_built = $false } | ConvertTo-Json
} finally {
  $resolvedStaging = [IO.Path]::GetFullPath($stagingDirectory)
  if ($resolvedStaging.StartsWith($tempParent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedStaging -Leaf) -eq $stagingName) {
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
  }
}
