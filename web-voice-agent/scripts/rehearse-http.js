// Developer-only LOCAL HTTP checks with simulated recognized text.
// No microphone, ASR, TTS, model or device invocation; never exposes a text chat UI.
const assert = require("node:assert/strict");
const { scenarios } = require("./rehearse-demo");

function localBase(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("LOCAL_DEMO_URL_REQUIRED");
  return url.origin;
}

async function runHttpRehearsal({ base = "http://127.0.0.1:8095", fetchImpl = globalThis.fetch } = {}) {
  base = localBase(base);
  async function request(path, cookie = "", body) {
    const result = await fetchImpl(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : {
        "Content-Type": "application/json", "X-Voice-Agent-Request": "1", Origin: base,
      }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw new Error(`LOCAL_HTTP_CHECK_FAILED_${result.status}`);
    return result;
  }
  const health = await (await request("/api/health")).json();
  assert.equal(health.service, "space-experiment-voice-agent");
  const report = { input_mode: "SIMULATED_ASR_TEXT_OVER_LOCAL_HTTP", checked_url: base,
    real_audio_verified: false, cloud_speech_called: false, cloud_model_called: false,
    device_connected: false, browser_owner_session_modified: false, scenarios: [] };
  for (const scenario of scenarios) {
    // A separate synthetic owner per scenario, never the user's browser cookie.
    const access = await request("/api/access", "", {});
    const cookie = access.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "FRESH_TEST_OWNER_REQUIRED");
    const caps = await (await request("/api/capabilities", cookie)).json();
    assert.equal(caps.deployment_mode, "LOCAL_DEMO");
    assert.equal(caps.detailed_demo_step_count, 9);
    assert.equal(caps.knowledge_understanding.configured, false, "REAL_MODEL_MUST_REMAIN_DISABLED");
    const voice = await (await request("/api/voice/config", cookie)).json();
    assert.equal(voice.asr.configured, false, "REAL_ASR_MUST_REMAIN_DISABLED");
    assert.equal(voice.tts.configured, false, "REAL_TTS_MUST_REMAIN_DISABLED");
    const procedures = await (await request("/api/procedures", cookie)).json();
    assert.equal(procedures.procedures[0].step_count, 9);
    assert.equal(procedures.procedures[0].missing_detail_count, 15);
    let session = await (await request("/api/session", cookie, {})).json();
    const turns = [];
    for (const utterance of scenario.utterances) {
      const before = structuredClone(session);
      const response = await (await request("/api/voice/turn", cookie, {
        session_id: session.session_id, recognized_text: utterance,
      })).json();
      session = response.session;
      if (["KNOWLEDGE_ANSWER", "SOURCE_CONFLICT", "KNOWLEDGE_NO_TELEMETRY", "GUIDANCE_REPEATED", "GUIDANCE_SUMMARY", "STEP_HELP", "RECORD_EXPORT"].includes(response.response_type)) {
        // Revision is transport sequencing; all actual task fields must remain identical.
        const { revision: nextRevision, ...nextTask } = session;
        const { revision: previousRevision, ...previousTask } = before;
        assert.equal(nextRevision, previousRevision + 1);
        assert.deepEqual(nextTask, previousTask, "READ_ONLY_TURN_CHANGED_TASK_STATE");
      }
      turns.push({ operator: utterance, response_type: response.response_type,
        current_step: session.current_step, status: session.status,
        step_state: session.step_state, completed_gates: session.completed_steps?.length || 0 });
    }
    assert.equal(session.status, scenario.expected_status || "COMPLETED");
    assert.equal(session.completed_steps.length, scenario.expected_confirmed_steps ?? 9);
    if (scenario.name.startsWith("exception_holds")) {
      assert.ok(turns.some((turn) => turn.response_type === "VALIDATION_FAILED"));
      assert.ok(turns.some((turn) => turn.response_type === "RESUME_REQUIRES_CONFIRMATION"));
    }
    if (scenario.name.startsWith("identity_exception")) {
      const details = turns.filter((turn) => turn.response_type === "EXCEPTION_DETAILS_RECORDED");
      assert.equal(details.length, 3); assert.ok(details.every((turn) => turn.status === "EXCEPTION_REPORTED"));
    }
    if (scenario.name === "operator_recheck_keeps_confirmed_history") {
      assert.equal(turns.filter(turn => turn.response_type === "STEP_RECHECK_STARTED").length, 2);
      assert.equal(session.event_log.filter(event => event.event_type === "STEP_RECHECK_REQUESTED").length, 2);
      assert.equal(session.step_records.melfi_storage_check.observations.melfi_temperature_c, -82);
      assert.equal(turns.at(-1).response_type, "RECORD_EXPORT");
    }
    const refreshed = await (await request("/api/session", cookie, {})).json();
    assert.deepEqual(refreshed, session, "SAME_OWNER_REFRESH_DID_NOT_PRESERVE_TASK");
    report.scenarios.push({ name: scenario.name, confirmed_gates: session.completed_steps.length,
      final_status: session.status, same_owner_refresh_preserved: true, turns });
  }
  return report;
}

if (require.main === module) runHttpRehearsal({ base: process.argv[2] }).then((report) => {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}).catch((error) => {
  // No raw upstream content, credentials or owner cookies in diagnostics.
  process.stderr.write(/^[A-Z0-9_]+$/u.test(error.message) ? error.message + "\n" : "LOCAL_HTTP_REHEARSAL_FAILED\n");
  process.exitCode = 1;
});
module.exports = { localBase, runHttpRehearsal };
