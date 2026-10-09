# Smoke-test the generated archive in an isolated directory. No speech/cloud requests.
$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$bundleVersion = (Get-Content -LiteralPath (Join-Path $projectDirectory 'web-voice-agent/package.json') -Raw | ConvertFrom-Json).version
$archivePath = Join-Path $projectDirectory ("dist/space-experiment-voice-agent-$bundleVersion.zip")
$stageName = 'voice-bundle-check-' + [Guid]::NewGuid().ToString('N')
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stagePath = [IO.Path]::GetFullPath((Join-Path $tempParent $stageName))
if (-not $stagePath.StartsWith($tempParent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid bundle test target.' }
$bundledNode = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
$nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($nodeCommand) { $nodeCommand.Source } else { throw 'Node.js 24 is required.' }
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($entry in $zip.Entries) {
    $destination = [IO.Path]::GetFullPath((Join-Path $stagePath $entry.FullName))
    if (-not $destination.StartsWith($stagePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path.' }
    if ($entry.FullName.Replace('\','/') -match '(^|/)(\.env|\.env\.deploy)$|project-question-candidates|\.docx$|(^|/)data/|\.sqlite(?:-wal|-shm)?$') { throw 'Private input unexpectedly included.' }
  }
} finally { $zip.Dispose() }
$process = $null
try {
  [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $stagePath)
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $nodePath; $info.WorkingDirectory = $stagePath
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.EnvironmentVariables['APP_ENV'] = 'development'; $info.EnvironmentVariables['HOST'] = '127.0.0.1'
  foreach ($key in @('PUBLIC_ORIGIN','DEPLOY_ACCESS_TOKEN','OPENAI_API_KEY','BAIDU_API_KEY','BAIDU_SECRET_KEY','ASR_UPSTREAM_URL','TTS_UPSTREAM_URL','ASR_API_KEY','TTS_API_KEY','SEMANTIC_API_KEY','SEMANTIC_MODEL')) { $info.EnvironmentVariables.Remove($key) }
  $info.EnvironmentVariables['SEMANTIC_PROVIDER'] = 'none'
  $info.EnvironmentVariables['ASR_PROVIDER'] = 'generic_http'; $info.EnvironmentVariables['TTS_PROVIDER'] = 'browser'
  $script = @'
const assert=require('node:assert/strict');
const {createApp}=require('./web-voice-agent/server/app-server');
(async()=>{
 const {server}=createApp();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 try {
  const base='http://127.0.0.1:'+server.address().port;
  const granted=await fetch(base+'/api/access',{method:'POST',headers:{'Content-Type':'application/json','X-Voice-Agent-Request':'1'},body:'{}'});
  assert.equal(granted.status,200);const cookie=granted.headers.get('set-cookie').split(';')[0];
  const caps=await(await fetch(base+'/api/capabilities',{headers:{Cookie:cookie}})).json();
  assert.equal(caps.experiment_count,20);assert.equal(caps.core_question_count,20);assert.equal(caps.demo_procedure_count,1);assert.equal(caps.flight_ready,false);
  assert.equal(caps.expanded_question_count,16);assert.equal(caps.curated_question_count,36);assert.equal(caps.public_source_count,46);
  assert.equal(caps.record_export,true);assert.equal(caps.task_change_confirmation,true);assert.equal(caps.voice_turn_deduplication,true);
  assert.equal(caps.review_draft_count,4);
  assert.equal(caps.detailed_demo_step_count,9);assert.equal(caps.knowledge_understanding.configured,false);
  const readiness=await(await fetch(base+'/api/readiness',{headers:{Cookie:cookie}})).json();
  assert.equal(readiness.configuration_ready,false);assert.equal(readiness.recognition_configured,false);assert.equal(readiness.cloud_requests,false);
  const page=await(await fetch(base+'/')).text();assert.ok(page.includes('voiceButton'));assert.ok(!/<textarea|<input/i.test(page));
  console.log(JSON.stringify({bundle_smoke_test:'PASS',runtime:process.versions.node,experiment_count:caps.experiment_count,core_question_count:caps.core_question_count,cloud_requests:false,container_built:false}));
 } finally {await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})}
 const regression=require('node:child_process').spawnSync(process.execPath,['web-voice-agent/scripts/run-tests.js'],{encoding:'utf8',timeout:12000,maxBuffer:4*1024*1024});
 if(regression.status!==0) throw new Error('BUNDLE_REGRESSION_FAILED\n'+regression.stdout+'\n'+regression.stderr);
 const totals=regression.stdout.match(/(?:ℹ|#)\s+tests\s+(\d+)/u);
 if(!totals) throw new Error('BUNDLE_TEST_TOTAL_MISSING');
 console.log(JSON.stringify({bundle_regression:'PASS',public_tests:Number(totals[1]),private_candidate_test_included:false,cloud_requests:false}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
'@
  $info.ArgumentList.Add('-e'); $info.ArgumentList.Add($script)
  $process = [Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(15000)) { $process.Kill($true); throw 'Bundle verification exceeded its deadline.' }
  $output = $stdout.GetAwaiter().GetResult(); $errors = $stderr.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw ('Bundle verification failed: ' + $errors) }
  Write-Output $output.Trim()
} finally {
  if ($process) { if (-not $process.HasExited) { $process.Kill($true) }; $process.Dispose() }
  $resolvedStage = [IO.Path]::GetFullPath($stagePath)
  if ((Test-Path -LiteralPath $resolvedStage) -and $resolvedStage.StartsWith($tempParent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedStage -Leaf) -eq $stageName) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
