const test = require("node:test");
const assert = require("node:assert/strict");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { ProcedureEngine } = require("../server/procedure-engine");
const { classifyVoiceIntent } = require("../server/voice-intents");
const { SessionStore } = require("../server/deployment-security");
const { riceReports } = require("../scripts/demo-inputs");

function agent() {
  return new AgentOrchestrator({ semanticAdapter: {
    getPublicConfig: () => ({ configured: false }), select: async () => null,
  } });
}
const say = (instance, session, recognized_text) => instance.handleVoiceTurn({ session, recognized_text });
async function reach(index = 0) {
  const instance = agent();
  let result = await say(instance, instance.createSession(), "选择太空水稻实验");
  result = await say(instance, result.session, "开始流程");
  for (const report of riceReports.slice(0, index)) {
    result = await say(instance, result.session, report);
    result = await say(instance, result.session, "确认无误");
  }
  return { instance, session: result.session };
}

test("recheck is an explicit command; questions, negation and real faults are not resets", () => {
  for (const text of ["重新核对本步", "请重新核对本步骤。", "重新核对当前步骤", "重新报告本步", "重新报告本步骤"]) {
    assert.equal(classifyVoiceIntent(text), "RECHECK_STEP", text);
  }
  for (const text of ["重新核对本步骤？", "可以重新核对本步吗", "如果重新核对本步会怎样", "不要重新核对本步"]) {
    assert.notEqual(classifyVoiceIntent(text), "RECHECK_STEP", text);
  }
  assert.equal(classifyVoiceIntent("重新核对本步骤，容器标签不一致"), "EXCEPTION");
});

test("recheck withdraws the pending report, retains history, and requires fresh data and confirmation", async () => {
  const { instance, session } = await reach(1);
  const pending = await say(instance, session, riceReports[1]);
  const original = structuredClone(pending.session);
  const reset = await say(instance, pending.session, "重新核对本步骤");
  assert.equal(reset.response_type, "STEP_RECHECK_STARTED");
  assert.equal(reset.session.current_step, original.current_step);
  assert.equal(reset.session.pending_confirmation, null);
  assert.deepEqual(reset.session.step_observations, {});
  assert.equal(reset.session.observations.melfi_temperature_c, undefined);
  assert.equal(reset.session.observations.cultivation_days, 95);
  assert.deepEqual(reset.session.completed_steps, original.completed_steps);
  assert.deepEqual(reset.session.step_records, original.step_records);
  assert.deepEqual(pending.session, original, "input snapshot must not be mutated");
  const event = reset.session.event_log.at(-1);
  assert.equal(event.event_type, "STEP_RECHECK_REQUESTED");
  assert.deepEqual(event.data.previous_observations, { melfi_temperature_c: -80 });
  assert.equal(event.data.independently_verified, false);
  assert.match(reset.speech_text, /无需重复实验动作/u);
  const premature = await say(instance, reset.session, "确认无误");
  assert.equal(premature.response_type, "STEP_WAITING_INPUT");
  const corrected = await say(instance, premature.session, "温度负八十二度");
  assert.equal(corrected.response_type, "STEP_AWAITING_CONFIRMATION");
  assert.equal(corrected.session.current_step, original.current_step);
  const next = await say(instance, corrected.session, "确认无误");
  assert.equal(next.session.completed_steps.length, 2);
  assert.equal(next.session.step_records[original.current_step].observations.melfi_temperature_c, -82);
  const exported = await say(instance, next.session, "保存记录");
  assert.ok(exported.record_export.data.session.event_log.some(item => item.event_type === "STEP_RECHECK_REQUESTED"));
});

test("missing-input help identifies only unreported fields and never confirms them", async () => {
  const { instance, session } = await reach();
  const partial = await say(instance, session, "培养周期九十五天");
  const help = await say(instance, partial.session, "本步还缺什么");
  assert.equal(help.response_type, "STEP_HELP");
  assert.deepEqual(help.session, partial.session);
  const remaining = /还缺：([^。]+)/u.exec(help.speech_text)?.[1];
  assert.ok(remaining);
  assert.doesNotMatch(remaining, /周期天数/u);
  assert.match(remaining, /成熟|营养液/u);
  const pending = await say(instance, help.session, riceReports[0]);
  const complete = await say(instance, pending.session, "这一步还缺什么？");
  assert.deepEqual(complete.session, pending.session);
  assert.match(complete.speech_text, /等待核对确认/u);
});

test("rechecking cannot bypass an operator pause, a failed validation or a reported exception", async () => {
  const { instance, session } = await reach(1);
  for (const report of ["暂停", "温度负六十度", "冷冻箱发生故障"]) {
    const paused = await say(instance, session, report);
    const reset = await say(instance, paused.session, "重新核对本步骤");
    assert.equal(reset.response_type, "STEP_RECHECK_BLOCKED", report);
    assert.deepEqual(reset.session, paused.session);
    const help = await say(instance, reset.session, "本步还缺什么");
    assert.deepEqual(help.session, paused.session);
    assert.match(help.speech_text, /流程保持暂停/u);
  }
});

test("idle, unstarted and completed tasks cannot be started or reopened by recheck", async () => {
  const instance = agent();
  const idle = instance.createSession();
  assert.deepEqual((await say(instance, idle, "重新核对本步骤")).session, idle);
  const selected = await say(instance, idle, "选择太空水稻实验");
  assert.deepEqual((await say(instance, selected.session, "重新核对本步骤")).session, selected.session);
  const completed = await reach(9);
  const result = await say(completed.instance, completed.session, "重新核对本步骤");
  assert.equal(result.response_type, "PROCEDURE_COMPLETED");
  assert.deepEqual(result.session, completed.session);
});

test("read-only help preserves a pending task change, but a new recheck cancels it", async () => {
  const { instance, session } = await reach();
  const pending = await say(instance, session, riceReports[0]);
  const switchRequest = await say(instance, pending.session, "切换到蛋白质结晶实验");
  for (const command of ["本步还缺什么", "读回数据", "当前状态", "如果重新核对本步骤会怎样？", "查看流程草案"]) {
    const result = await say(instance, switchRequest.session, command);
    assert.deepEqual(result.session, switchRequest.session, command);
  }
  const recheck = await say(instance, switchRequest.session, "重新核对本步骤");
  assert.equal(recheck.session.pending_task_change, null);
  const stale = await say(instance, recheck.session, "确认切换");
  assert.equal(stale.session.experiment_id, session.experiment_id);
  assert.deepEqual(stale.session.step_observations, {});
});

test("recheck works with a second generic procedure and treats false and zero as reported data", () => {
  // Software fixture only: no experimental method or numerical pass limit.
  const procedure = { procedure_id: "test-only-recheck", version: "fixture-1", steps: [{
    step_id: "fixture-step", name: "测试记录", spoken_instruction: "报告测试记录。",
    required_inputs: [{ name: "flag", label: "测试标记", type: "boolean", aliases: ["测试标记"] },
      { name: "count", label: "测试数量", type: "number", aliases: ["测试数量"] }],
  }] };
  const engine = new ProcedureEngine();
  let result = engine.start({ session_id: "fixture-session", experiment_id: "fixture-experiment" }, procedure);
  result = engine.handleInput(result.session, procedure, "测试标记未完成，测试数量零");
  assert.deepEqual(result.session.step_observations, { flag: false, count: 0 });
  assert.match(engine.handleInput(result.session, procedure, "本步还缺什么").speech_text, /等待核对确认/u);
  const recheck = engine.handleInput(result.session, procedure, "重新核对本步骤");
  assert.equal(recheck.response_type, "STEP_RECHECK_STARTED");
  assert.deepEqual(recheck.session.step_observations, {});
  assert.equal(recheck.session.experiment_id, "fixture-experiment");
  assert.equal(engine.handleInput(recheck.session, procedure, "确认无误").response_type, "STEP_WAITING_INPUT");
});

test("stale procedure versions and review drafts remain blocked for recheck", async () => {
  const { instance, session } = await reach(1);
  const mismatch = await say(instance, { ...session, procedure_version: "outdated" }, "重新核对本步骤");
  assert.equal(mismatch.response_type, "PROCEDURE_VERSION_MISMATCH");
  assert.equal(mismatch.session.status, "PAUSED");
  for (const draft of instance.procedureRegistry.drafts) {
    const name = instance.experimentRegistry.list().find(item => item.experiment_id === draft.experiment_id).display_name;
    const selected = await say(instance, instance.createSession(), `选择${name}`);
    const result = await say(instance, selected.session, "重新核对本步骤");
    assert.deepEqual(result.session, selected.session);
    assert.equal(instance.procedureEngine.handleInput(selected.session, draft, "重新核对本步骤").response_type, "PROCEDURE_REVIEW_REQUIRED");
  }
});

test("retrying a recheck records it once, and a stale confirmation cannot advance the next revision", async () => {
  const { instance, session } = await reach(1);
  const pending = await say(instance, session, riceReports[1]);
  const store = new SessionStore();
  const stored = store.create("recheck-owner", pending.session);
  const options = { requestId: "recheck-retry-0001", expectedRevision: 0, text: "重新核对本步骤" };
  const execute = saved => say(instance, saved, options.text);
  const first = await store.turn(stored.session_id, "recheck-owner", execute, options);
  const retried = await store.turn(stored.session_id, "recheck-owner", execute, options);
  assert.deepEqual(retried, first);
  assert.equal(first.session.event_log.filter(item => item.event_type === "STEP_RECHECK_REQUESTED").length, 1);
  await assert.rejects(store.turn(stored.session_id, "recheck-owner", saved => say(instance, saved, "确认无误"),
    { requestId: "stale-confirm-0001", expectedRevision: 0, text: "确认无误" }), /REVISION_CONFLICT/u);
  const premature = await store.turn(stored.session_id, "recheck-owner", saved => say(instance, saved, "确认无误"),
    { requestId: "fresh-confirm-0001", expectedRevision: 1, text: "确认无误" });
  assert.equal(premature.response_type, "STEP_WAITING_INPUT");
});
