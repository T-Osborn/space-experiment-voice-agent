const test = require("node:test");
const assert = require("node:assert/strict");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { SessionStore, DemoAccess, deploymentConfig } = require("../server/deployment-security");
const { createApp } = require("../server/app-server");
const { riceReports } = require("../scripts/demo-inputs");

const agent = () => new AgentOrchestrator({ semanticAdapter: { getPublicConfig: () => ({ configured: false }), select: async () => null } });
async function started() {
  const instance = agent();
  let result = await instance.handleVoiceTurn({ session: instance.createSession(), recognized_text: "选择太空水稻实验" });
  result = await instance.handleVoiceTurn({ session: result.session, recognized_text: "开始流程" });
  return { instance, session: result.session };
}
const say = (instance, session, recognized_text) => instance.handleVoiceTurn({ session, recognized_text });

test("help and record export do not confirm a pending measurement", async () => {
  const { instance, session } = await started();
  const pending = await say(instance, session, riceReports[0]);
  assert.equal(pending.response_type, "STEP_AWAITING_CONFIRMATION");
  const help = await say(instance, pending.session, "语音帮助");
  assert.deepEqual(help.session, pending.session);
  const saved = await say(instance, help.session, "保存记录");
  assert.equal(saved.response_type, "RECORD_EXPORT");
  assert.deepEqual(saved.session, pending.session);
  assert.equal(saved.record_export.data.device_verified, false);
  assert.equal(saved.record_export.data.session.completed_steps.length, 0);
  assert.ok(saved.record_export.data.session.pending_confirmation);
  assert.equal(saved.record_export.data.procedure.version, saved.session.procedure_version);
});

test("changing experiments requires specific confirmation and exports the original task", async () => {
  const { instance, session } = await started();
  const measured = await say(instance, session, riceReports[0]);
  const request = await say(instance, measured.session, "切换到蛋白质结晶实验");
  assert.equal(request.response_type, "TASK_CHANGE_REQUIRED");
  assert.equal(request.session.experiment_id, session.experiment_id);
  assert.deepEqual(request.session.step_observations, measured.session.step_observations);
  const wrong = await say(instance, request.session, "确认重新开始");
  assert.equal(wrong.session.experiment_id, session.experiment_id);
  const cancelled = await say(instance, request.session, "取消任务变更");
  assert.equal(cancelled.session.pending_task_change, null);
  const changed = await say(instance, request.session, "确认切换");
  assert.notEqual(changed.session.experiment_id, session.experiment_id);
  assert.equal(changed.session.status, "CONTEXT_SELECTED");
  assert.equal(changed.record_export.data.session.experiment_id, session.experiment_id);
  assert.deepEqual(changed.record_export.data.session.step_observations, measured.session.step_observations);
  assert.deepEqual(changed.session.observations, {});
  const blocked = await say(instance, changed.session, "开始流程");
  assert.equal(blocked.response_type, "PROCEDURE_REVIEW_REQUIRED");
});

test("ordinary confirmation cannot switch tasks; restart starts a clean task only after its confirmation", async () => {
  const { instance, session } = await started();
  const measured = await say(instance, session, riceReports[0]);
  const request = await say(instance, measured.session, "切换到蛋白质结晶实验");
  const ordinary = await say(instance, request.session, "确认无误");
  assert.equal(ordinary.session.experiment_id, session.experiment_id);
  assert.equal(ordinary.session.pending_task_change, null);
  const stale = await say(instance, ordinary.session, "确认切换");
  assert.equal(stale.response_type, "TASK_CHANGE_REQUIRED");
  const restart = await say(instance, ordinary.session, "重新开始");
  assert.equal(restart.session.current_step, ordinary.session.current_step);
  const fresh = await say(instance, restart.session, "确认重新开始");
  assert.equal(fresh.session.current_step, session.current_step);
  assert.equal(fresh.session.completed_steps.length, 0);
  assert.equal(fresh.record_export.data.session.completed_steps.length, 1);
});

test("lost response retries are idempotent and stale tabs cannot act on a newer step", async () => {
  const store = new SessionStore();
  const session = store.create("owner", { status: "IDLE" });
  let executions = 0;
  const handler = async saved => { executions++; return { session: { ...saved, status: "GUIDING" } }; };
  const options = { requestId: "same-request-123456", expectedRevision: 0, text: "确认无误" };
  const first = await store.turn(session.session_id, "owner", handler, options);
  const retried = await store.turn(session.session_id, "owner", handler, options);
  assert.deepEqual(first, retried);
  assert.equal(executions, 1);
  await assert.rejects(store.turn(session.session_id, "owner", handler, { ...options, text: "暂停" }), /TURN_ID_REUSED/u);
  await assert.rejects(store.turn(session.session_id, "owner", handler, { ...options, requestId: "another-request-123" }), /REVISION_CONFLICT/u);
  await assert.rejects(store.turn(session.session_id, "intruder", handler, options), /NOT_FOUND/u);
  await store.turn(session.session_id, "owner", handler, { ...options, requestId: "next-request-123456", expectedRevision: 1 });
  await assert.rejects(store.turn(session.session_id, "owner", handler, options), /TURN_SUPERSEDED/u);
  assert.equal(executions, 2);
});

test("failed turns can retry safely; receipt cache is bounded", async () => {
  const store = new SessionStore();
  const session = store.create("owner", {});
  const options = { requestId: "request-failed-123", expectedRevision: 0, text: "test" };
  await assert.rejects(store.turn(session.session_id, "owner", async () => { throw new Error("fixture"); }, options), /fixture/u);
  assert.equal(store.get(session.session_id, "owner").session.revision, 0);
  for (let i = 0; i < 20; i++) await store.turn(session.session_id, "owner", async saved => ({ session: saved }),
    { ...options, requestId: `request-${i}`, expectedRevision: i });
  assert.equal(store.get(session.session_id, "owner").receipts.size, 8);
});

test("repeat replays the last reply after playback failure without repeating downloads or actions", async () => {
  const store = new SessionStore();
  const session = store.create("owner", {});
  await store.turn(session.session_id, "owner", async saved => ({ session: saved, speech_text: "请确认切换。",
    record_export: { data: "fixture" }, response_type: "TASK_CHANGE_REQUIRED" }));
  const repeated = await store.turn(session.session_id, "owner", async () => { throw new Error("must not execute"); }, { repeatLast: true });
  assert.equal(repeated.speech_text, "请确认切换。");
  assert.equal(repeated.response_type, "GUIDANCE_REPEATED");
  assert.equal(repeated.record_export, undefined);
});

test("HTTP simulated audio completes the entire rice demo and exports confirmed records", async () => {
  const config = deploymentConfig({});
  let nextText = "";
  const spoken = [];
  const app = createApp({ config, orchestrator: agent(), access: new DemoAccess(config, { requestLimit: 300 }),
    asrAdapters: { getPublicConfig: () => ({ configured: true }), transcribe: async ({ audioBuffer }) => {
      assert.equal(audioBuffer.toString(), "SIMULATED_AUDIO_NOT_A_RECORDING"); return { ok: true, text: nextText };
    } },
    ttsAdapters: { getPublicConfig: () => ({ configured: true }), synthesize: async ({ text }) => {
      spoken.push(text); return { ok: true, buffer: Buffer.from("SIMULATED_TTS_NOT_PLAYABLE"), contentType: "audio/mpeg" };
    } },
  });
  await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = "";
  const post = (url, body, contentType = "application/json") => fetch(base + url, { method: "POST",
    headers: { Cookie: cookie, "X-Voice-Agent-Request": "1", "Content-Type": contentType },
    body: contentType === "application/json" ? JSON.stringify(body) : body });
  try {
    const access = await post("/api/access", {});
    cookie = access.headers.get("set-cookie").split(";")[0];
    let state = await (await post("/api/session", {})).json();
    let sequence = 0;
    async function voice(text) {
      nextText = text;
      const asr = await (await post("/api/asr/transcribe", "SIMULATED_AUDIO_NOT_A_RECORDING", "audio/webm")).json();
      assert.equal(asr.ok, true);
      const response = await post("/api/voice/turn", { session_id: state.session_id, recognized_text: asr.text,
        request_id: `http-rehearsal-${String(sequence++).padStart(4, "0")}`, expected_revision: state.revision });
      assert.equal(response.status, 200);
      const result = await response.json();
      state = result.session;
      const tts = await post("/api/tts/synthesize", { text: result.speech_text });
      assert.equal(tts.status, 200);
      assert.equal(await tts.text(), "SIMULATED_TTS_NOT_PLAYABLE");
      return result;
    }
    assert.equal((await voice("语音帮助")).response_type, "VOICE_HELP");
    await voice("选择太空水稻实验"); await voice("开始流程");
    for (const report of riceReports) {
      assert.equal((await voice(report)).response_type, "STEP_AWAITING_CONFIRMATION");
      await voice("确认无误");
    }
    assert.equal(state.status, "COMPLETED");
    assert.equal(state.completed_steps.length, 9);
    const saved = await voice("保存记录");
    assert.equal(saved.record_export.data.session.completed_steps.length, 9);
    assert.equal(Object.keys(saved.record_export.data.session.step_records).length, 9);
    assert.equal(spoken.length, 22);
    const restored = await (await post("/api/session", {})).json();
    assert.deepEqual(restored, state);
    const invalid = await post("/api/voice/turn", { session_id: state.session_id, recognized_text: "确认无误", request_id: "x" });
    assert.equal(invalid.status, 400);
  } finally { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); }
});
