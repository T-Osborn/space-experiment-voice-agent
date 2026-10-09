const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server/app-server");
const { deploymentConfig } = require("../server/deployment-security");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { SemanticAdapter } = require("../server/semantic-adapter");
const { localBase, runHttpRehearsal } = require("../scripts/rehearse-http");

test("HTTP rehearsals cannot target third parties or credential-bearing URLs", () => {
  assert.equal(localBase("http://127.0.0.1:8095"), "http://127.0.0.1:8095");
  for (const value of ["https://example.com", "http://remote.example", "http://user:pass@localhost:8095",
    "http://localhost:8095/path", "http://localhost:8095/?token=fixture", "http://localhost:8095/#access=fixture"]) {
    assert.throws(() => localBase(value), /LOCAL_DEMO_URL_REQUIRED/u);
  }
});

test("four simulated scenarios traverse real HTTP access, server-owned states and refresh continuity", async () => {
  const app = createApp({ config: deploymentConfig({}),
    orchestrator: new AgentOrchestrator({ semanticAdapter: new SemanticAdapter({ env: {} }) }),
    asrAdapters: { getPublicConfig: () => ({ configured: false }), transcribe: () => { throw new Error("UNEXPECTED_AUDIO"); } },
    ttsAdapters: { getPublicConfig: () => ({ configured: false }), synthesize: () => { throw new Error("UNEXPECTED_TTS"); } },
  });
  await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  try {
    const report = await runHttpRehearsal({ base: `http://127.0.0.1:${app.server.address().port}` });
    assert.equal(report.scenarios.length, 4); assert.equal(report.real_audio_verified, false);
    assert.ok(report.scenarios.every((scenario) => scenario.confirmed_gates === 9 && scenario.same_owner_refresh_preserved));
    assert.equal(report.cloud_speech_called, false); assert.equal(report.cloud_model_called, false);
    assert.equal(app.sessions.sessions.size, 4);
  } finally { await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); }
});
