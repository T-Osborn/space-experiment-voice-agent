const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const { summarizeReadiness } = require("../server/readiness");
const { BaiduSpeechClient } = require("../server/baidu-speech");
const { createApp } = require("../server/app-server");
const { deploymentConfig } = require("../server/deployment-security");

test("both recognition and the selected playback voice are required for a voice-only demo", () => {
  const recognitionOnly = summarizeReadiness({ asr: { configured: true }, tts: { configured: false }, demoProcedureAvailable: true });
  assert.equal(recognitionOnly.configuration_ready, false);
  assert.deepEqual(recognitionOnly.missing.map(x => x.code), ["SELECTED_VOICE_CONFIGURATION_REQUIRED"]);
  const noVoice = summarizeReadiness({ asr: { configured: false }, tts: { configured: false }, demoProcedureAvailable: true });
  assert.equal(noVoice.missing.length, 2);
  const complete = summarizeReadiness({ asr: { configured: true }, tts: { configured: true }, demoProcedureAvailable: true });
  assert.equal(complete.configuration_ready, true);
  assert.equal(complete.live_speech_verified, false);
  assert.equal(complete.microphone_verified, false);
  assert.equal(complete.cloud_requests, false);
});

test("browser playback is accepted only when explicitly enabled; no workflow means the demo is not ready", () => {
  const incomplete = { asr: { configured: true }, tts: { configured: false }, demoProcedureAvailable: true };
  assert.equal(summarizeReadiness(incomplete).configuration_ready, false);
  assert.equal(summarizeReadiness({ ...incomplete, tts: { browser_playback_allowed: true } }).configuration_ready, true);
  assert.equal(summarizeReadiness({ ...incomplete, tts: { configured: true }, demoProcedureAvailable: false }).configuration_ready, false);
});

test("Baidu credentials alone cannot mark an unfinished custom voice as ready", () => {
  const env = { BAIDU_API_KEY: "test-private-key", BAIDU_SECRET_KEY: "test-private-secret", BAIDU_TTS_SERVICE: "clone" };
  const client = new BaiduSpeechClient({ env: () => env, request: () => { throw new Error("no network allowed"); } });
  let report = summarizeReadiness({ asr: { configured: client.isConfigured() }, tts: { configured: client.isTtsConfigured() }, demoProcedureAvailable: true });
  assert.equal(report.configuration_ready, false);
  env.BAIDU_TTS_VOICE = "123456";
  report = summarizeReadiness({ asr: { configured: client.isConfigured() }, tts: { configured: client.isTtsConfigured() }, demoProcedureAvailable: true });
  assert.equal(report.configuration_ready, true);
  assert.doesNotMatch(JSON.stringify(report), /test-private|123456/u);
});

test("offline readiness command reports only status, never credentials or automatic authentication", () => {
  const key = "readiness-fixture-key-must-not-print";
  const secret = "readiness-fixture-secret-must-not-print";
  const result = spawnSync(process.execPath, [path.join(__dirname, "../scripts/check-readiness.js")], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, ASR_PROVIDER: "baidu", TTS_PROVIDER: "baidu", BAIDU_API_KEY: key,
      BAIDU_SECRET_KEY: secret, BAIDU_TTS_SERVICE: "clone", BAIDU_TTS_VOICE: "", BAIDU_TTS_SPEED: "5",
      BAIDU_TTS_PITCH: "5", BAIDU_TTS_VOLUME: "5" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(key)); assert.ok(!result.stdout.includes(secret));
  const report = JSON.parse(result.stdout);
  assert.equal(report.configuration_ready, false);
  assert.equal(report.recognition_configured, true);
  assert.equal(report.cloud_requests, false);
});

const unconfiguredEnv = () => ({ ...process.env, ASR_PROVIDER: "generic_http", ASR_UPSTREAM_URL: "",
  TTS_PROVIDER: "none", BAIDU_API_KEY: "", BAIDU_SECRET_KEY: "", OPENAI_API_KEY: "" });

test("ASCII readiness output preserves Chinese labels when decoded with a legacy Windows code page", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "../scripts/check-readiness.js"), "--ascii"], {
    encoding: "utf8", timeout: 5000, env: unconfiguredEnv(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /[^\x00-\x7f]/u);
  const legacyDecoded = new TextDecoder("gbk").decode(Buffer.from(result.stdout));
  const report = JSON.parse(legacyDecoded);
  assert.deepEqual(report.missing.map(item => item.label), ["语音识别配置", "所选音色配置"]);
  assert.equal(report.cloud_requests, false);
});

test("Windows launcher parses readiness under both CMD CP936 and UTF-8", { skip: process.platform !== "win32" }, () => {
  const bundled = path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe");
  const powershell = fs.existsSync(bundled) ? bundled
    : path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const launcher = path.join(__dirname, "../start-app.ps1").replace(/'/g, "''");
  for (const codePage of [936, 65001]) {
    const script = `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(${codePage}); $ErrorActionPreference = 'Stop'; `
      + `$report = (& '${launcher}' -CheckOnly) | ConvertFrom-Json; `
      + `if ($report.voice_readiness.missing[0].label -ne '语音识别配置') { throw 'LABEL_MISMATCH' }; `
      + `if ($report.key_required_to_start -or $report.cloud_requests) { throw 'UNEXPECTED_STARTUP_BEHAVIOUR' }; `
      + `Write-Output 'STARTUP_CHECK_OK'`;
    const result = spawnSync(powershell, ["-NoProfile", "-Command", script], {
      encoding: "utf8", timeout: 15000, env: unconfiguredEnv(), windowsHide: true,
    });
    assert.equal(result.status, 0, `CP${codePage}: ${result.stderr}`);
    assert.match(result.stdout, /STARTUP_CHECK_OK/u);
  }
});

test("readiness HTTP endpoint is access-controlled and checking it cannot call a speech provider", async () => {
  const app = createApp({ config: deploymentConfig({}),
    asrAdapters: { getPublicConfig: () => ({ configured: true }), transcribe: () => { throw new Error("unexpected ASR"); } },
    ttsAdapters: { getPublicConfig: () => ({ configured: false }), synthesize: () => { throw new Error("unexpected TTS"); } },
  });
  await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(base + "/api/readiness")).status, 401);
    const grant = await fetch(base + "/api/access", { method: "POST", headers: { "Content-Type": "application/json", "X-Voice-Agent-Request": "1" }, body: "{}" });
    const cookie = grant.headers.get("set-cookie").split(";")[0];
    const result = await fetch(base + "/api/readiness", { headers: { Cookie: cookie } });
    assert.equal(result.status, 200);
    const report = await result.json();
    assert.equal(report.configuration_ready, false);
    assert.deepEqual(report.missing.map(x => x.code), ["SELECTED_VOICE_CONFIGURATION_REQUIRED"]);
    assert.equal(report.cloud_requests, false);
  } finally { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); }
});
