const test = require("node:test");
const assert = require("node:assert/strict");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { ProcedureEngine } = require("../server/procedure-engine");
const { ProcedureRegistry } = require("../server/procedure-registry");
const { ExperimentRegistry } = require("../server/experiment-registry");
const { classifyVoiceIntent } = require("../server/voice-intents");
const { parseSpokenNumber, extractStepInputs } = require("../server/spoken-inputs");
const { riceReports } = require("../scripts/demo-inputs");

const rice = new ProcedureRegistry().getForExperiment("rice_in_orbit_preprocessing_demo");
const cultivationFeedback = "培养周期九十五天，成熟度评估已完成，种子已成熟，营养液剩余百分之二十五";

async function turn(agent, session, text) {
  return agent.handleVoiceTurn({ session, recognized_text: text });
}

async function startRice() {
  const agent = new AgentOrchestrator();
  const selected = await turn(agent, agent.createSession(), "选择太空水稻在轨取样预处理实验");
  const started = await turn(agent, selected.session, "开始流程");
  return { agent, session: started.session };
}

async function startTemperature() {
  const { agent, session } = await startRice();
  const readback = await turn(agent, session, cultivationFeedback);
  const next = await turn(agent, readback.session, "确认无误");
  assert.equal(next.session.current_step, "melfi_storage_check");
  return { agent, session: next.session };
}

test("spoken numbers retain negatives, decimal digits and Chinese units", () => {
  for (const [text, expected] of [
    ["九十五", 95], ["一百二十", 120], ["一百零五", 105], ["二十五", 25],
    ["负八十", -80], ["零下八十点五", -80.5], ["负80.5", -80.5],
    ["一二〇", 120], ["两百", 200], ["八十点零五", 80.05], ["-.5", -0.5],
  ]) assert.equal(parseSpokenNumber(text), expected, text);
  assert.equal(parseSpokenNumber("十百"), null);
  assert.equal(parseSpokenNumber("一百五"), null);
});

test("each field uses its own reported number, boolean or enum", () => {
  const result = extractStepInputs(rice.steps[0], cultivationFeedback);
  assert.deepEqual(result.values, {
    cultivation_days: 95, seed_maturity_assessed: true, seed_maturity: "mature", nutrient_remaining_percent: 25,
  });
  assert.deepEqual(result.ambiguous, []);
  assert.deepEqual(extractStepInputs(rice.steps[2], riceReports[2]).values, {
    sampling_utc: "2026-10-07T08:30:00Z", equipment_id: "GBCM-01",
  });
});

test("a standalone answer is assigned only to the field being asked", () => {
  assert.deepEqual(extractStepInputs(rice.steps[0], "九十五天").values, { cultivation_days: 95 });
  assert.deepEqual(extractStepInputs(rice.steps[2], "已完成").values, {});
  assert.deepEqual(extractStepInputs(rice.steps[1], "设备编号8088").values, {});
  assert.deepEqual(extractStepInputs(rice.steps[1], "温度零下八十度").values, { melfi_temperature_c: -80 });
  assert.deepEqual(extractStepInputs(rice.steps[0], "百分之二十五", {
    cultivation_days: 95, seed_maturity_assessed: true, seed_maturity: "mature",
  }).values, { nutrient_remaining_percent: 25 });
});

test("maturity-assessment wording does not also assert that seeds are mature", () => {
  const result = extractStepInputs(rice.steps[0], "种子成熟度评估已完成");
  assert.deepEqual(result.values, { seed_maturity_assessed: true });
});

test("ranges and conflicting values require clarification instead of guessing", () => {
  for (const text of ["温度负七十到负八十度", "温度大概负八十度", "温度负八十度，温度负七十五度"]) {
    const result = extractStepInputs(rice.steps[1], text);
    assert.deepEqual(result.values, {});
    assert.deepEqual(result.ambiguous, ["melfi_temperature_c"]);
  }
});

test("negative maturity is not read as mature", () => {
  assert.equal(extractStepInputs(rice.steps[0], "种子不成熟").values.seed_maturity, "immature");
  assert.equal(extractStepInputs(rice.steps[0], "成熟度评估尚未完成").values.seed_maturity_assessed, false);
});

test("questions containing values or next-step words remain knowledge questions", () => {
  for (const text of ["为什么温度要低于负七十度？", "如果培养周期120天，下一步怎么做", "种子是否成熟", "继续有什么条件"]) {
    assert.equal(classifyVoiceIntent(text), "KNOWLEDGE", text);
  }
});

test("a complete report gets read back and never advances in the same turn", async () => {
  const { agent, session } = await startRice();
  const readback = await turn(agent, session, cultivationFeedback);
  assert.equal(readback.response_type, "STEP_AWAITING_CONFIRMATION");
  assert.equal(readback.session.current_step, "cultivation_state_check");
  assert.match(readback.speech_text, /95天/u);
  assert.match(readback.speech_text, /百分之25/u);
  const next = await turn(agent, readback.session, "确认无误");
  assert.equal(next.session.current_step, "melfi_storage_check");
  assert.deepEqual(next.session.step_observations, {});
  assert.equal(next.session.completed_steps.length, 1);
});

test("next step cannot skip missing measurements", async () => {
  const { agent, session } = await startRice();
  const result = await turn(agent, session, "下一步");
  assert.equal(result.response_type, "STEP_WAITING_INPUT");
  assert.equal(result.session.current_step, "cultivation_state_check");
  assert.deepEqual(result.session.observations, {});
});

test("knowledge questions during guidance preserve measurements and step", async () => {
  const { agent, session } = await startTemperature();
  const question = await turn(agent, session, "为什么MELFI温度有负七十和负九十五摄氏度的区别？");
  assert.ok(["KNOWLEDGE_ANSWER", "SOURCE_CONFLICT", "KNOWLEDGE_MISSING"].includes(question.response_type));
  assert.deepEqual(question.session, session);
  assert.equal(question.procedure.current_step, "melfi_storage_check");
});

test("repeat, status and summary do not start, confirm or advance steps", async () => {
  const { agent, session } = await startTemperature();
  const report = await turn(agent, session, "温度负八十度");
  for (const [command, expected] of [["再说一遍", "GUIDANCE_REPEATED"], ["当前状态", "GUIDANCE_STATUS"], ["总结", "GUIDANCE_SUMMARY"]]) {
    const result = await turn(agent, report.session, command);
    assert.equal(result.response_type, expected);
    assert.deepEqual(result.session, report.session);
  }
  const repeat = await turn(agent, report.session, "再说一遍");
  assert.match(repeat.speech_text, /负80摄氏度/u);
});

test("correcting an already read-back measurement requires a fresh confirmation", async () => {
  const { agent, session } = await startTemperature();
  const first = await turn(agent, session, "温度负八十度");
  const corrected = await turn(agent, first.session, "更正温度负八十二度");
  assert.equal(corrected.response_type, "STEP_AWAITING_CONFIRMATION");
  assert.equal(corrected.session.current_step, "melfi_storage_check");
  assert.equal(corrected.session.step_observations.melfi_temperature_c, -82);
  assert.match(corrected.speech_text, /负82摄氏度/u);
});

test("an ambiguous correction invalidates the earlier value and confirmation", async () => {
  const { agent, session } = await startTemperature();
  const first = await turn(agent, session, "温度负八十度");
  const ambiguous = await turn(agent, first.session, "温度负八十一到负八十二度");
  assert.equal(ambiguous.response_type, "STEP_INPUT_AMBIGUOUS");
  assert.equal(ambiguous.session.pending_confirmation, null);
  assert.equal(ambiguous.session.step_observations.melfi_temperature_c, undefined);
  const cannotContinue = await turn(agent, ambiguous.session, "确认无误");
  assert.equal(cannotContinue.response_type, "STEP_WAITING_INPUT");
});

test("ordinary pause preserves read-back data and resumes without advancing", async () => {
  const { agent, session } = await startTemperature();
  const report = await turn(agent, session, "温度负八十度");
  const paused = await turn(agent, report.session, "暂停");
  const resumed = await turn(agent, paused.session, "恢复流程");
  assert.equal(resumed.response_type, "GUIDANCE_RESUMED");
  assert.equal(resumed.session.current_step, "melfi_storage_check");
  assert.equal(resumed.session.step_state, "WAITING_STEP_CONFIRMATION");
  assert.equal(resumed.session.step_observations.melfi_temperature_c, -80);
});

test("a failed validation cannot be bypassed by another acceptable measurement", async () => {
  const { agent, session } = await startTemperature();
  const failed = await turn(agent, session, "温度负六十度");
  assert.equal(failed.response_type, "VALIDATION_FAILED");
  const bypass = await turn(agent, failed.session, "温度负八十度");
  assert.equal(bypass.response_type, "RESUME_REQUIRES_CONFIRMATION");
  assert.equal(bypass.session.status, "PAUSED");
  assert.equal(bypass.session.current_step, "melfi_storage_check");
  assert.equal(bypass.session.step_observations.melfi_temperature_c, -60);
});

test("reported exception holds the step when the operator only says continue", async () => {
  const { agent, session } = await startTemperature();
  const exception = await turn(agent, session, "冷冻箱发生故障");
  const result = await turn(agent, exception.session, "继续");
  assert.equal(result.response_type, "RESUME_REQUIRES_CONFIRMATION");
  assert.equal(result.session.status, "EXCEPTION_REPORTED");
  assert.equal(result.session.current_step, "melfi_storage_check");
});

test("operator-reported recovery is logged as unverified and rechecks current inputs", async () => {
  const { agent, session } = await startTemperature();
  const failed = await turn(agent, session, "温度负六十度");
  const restored = await turn(agent, failed.session, "异常已评估，恢复条件已满足，地面同意恢复流程");
  assert.equal(restored.response_type, "GUIDANCE_RESUMED");
  assert.deepEqual(restored.session.step_observations, {});
  assert.equal(restored.session.observations.melfi_temperature_c, undefined);
  assert.equal(restored.session.event_log.at(-1).data.independently_verified, false);
  const next = await turn(agent, restored.session, "下一步");
  assert.equal(next.response_type, "STEP_WAITING_INPUT");
});

test("a negated or hypothetical recovery instruction cannot resume the procedure", async () => {
  const { agent, session } = await startTemperature();
  const failed = await turn(agent, session, "温度负六十度");
  for (const text of [
    "异常已评估，恢复条件已满足，但没有地面同意恢复流程",
    "如果异常已评估，恢复条件已满足，地面同意恢复流程，会怎样？",
  ]) {
    const result = await turn(agent, failed.session, text);
    assert.equal(result.session.status, "PAUSED");
    assert.equal(result.session.current_step, "melfi_storage_check");
  }
});

test("unknown experiment selection does not reuse the current experiment", async () => {
  const { agent, session } = await startRice();
  const result = await turn(agent, session, "切换到未知的月球土壤实验");
  assert.equal(result.response_type, "EXPERIMENT_UNREGISTERED");
  assert.deepEqual(result.session, session);
});

test("mentioning another experiment in a question does not switch or erase guidance", async () => {
  const { agent, session } = await startRice();
  const result = await turn(agent, session, "蛋白质结晶实验和水稻实验有什么区别？");
  assert.deepEqual(result.session, session);
  assert.equal(result.experiment.experiment_id, session.experiment_id);
});

test("another experiment mentioned in an exception cannot erase the current procedure", async () => {
  const { agent, session } = await startRice();
  const result = await turn(agent, session, "与蛋白质结晶实验一样出现故障");
  assert.equal(result.session.experiment_id, session.experiment_id);
  assert.equal(result.session.procedure_id, session.procedure_id);
  assert.equal(result.response_type, "EXCEPTION_REPORTED");
});

test("a second synthetic procedure uses the same engine without rice-specific state", () => {
  const engine = new ProcedureEngine();
  const registry = new ExperimentRegistry();
  const old = engine.start({ experiment_id: rice.experiment_id }, rice).session;
  const selected = registry.route("选择蛋白质结晶实验", { ...old, observations: { cultivation_days: 95 }, last_exception: { description: "old" } });
  assert.equal(selected.session.procedure_id, null);
  assert.deepEqual(selected.session.observations, {});
  assert.equal(selected.session.last_exception, null);
  // Fictional software fixture only; no scientific procedure or threshold is introduced.
  const fixture = {
    procedure_id: "test-only-procedure", steps: [{
      step_id: "test-check", name: "测试项确认", spoken_instruction: "报告测试项。",
      required_inputs: [{ name: "test_done", label: "测试项完成", type: "boolean", aliases: ["测试项"] }],
      validation_rules: [{ field: "test_done", operator: "equals", value: true }],
    }],
  };
  const started = engine.start(selected.session, fixture);
  const report = engine.handleInput(started.session, fixture, "测试项已完成");
  assert.equal(report.response_type, "STEP_AWAITING_CONFIRMATION");
  const finished = engine.handleInput(report.session, fixture, "确认无误");
  assert.equal(finished.response_type, "PROCEDURE_COMPLETED");
  assert.deepEqual(finished.session.observations, { test_done: true });
});

test("all nine project demo gates require read-back and confirmation and produce a summary", async () => {
  let { agent, session } = await startRice();
  const feedback = riceReports;
  for (let i = 0; i < feedback.length; i += 1) {
    const report = await turn(agent, session, feedback[i]);
    assert.equal(report.response_type, "STEP_AWAITING_CONFIRMATION", feedback[i]);
    assert.equal(report.session.current_step, rice.steps[i].step_id);
    const confirmed = await turn(agent, report.session, "确认无误");
    session = confirmed.session;
    assert.equal(session.completed_steps.length, i + 1);
  }
  assert.equal(session.status, "COMPLETED");
  const summary = await turn(agent, session, "总结");
  assert.equal(summary.response_type, "GUIDANCE_SUMMARY");
  assert.match(summary.speech_text, /9个步骤/u);
  assert.match(summary.speech_text, /负80摄氏度/u);
  const continued = await turn(agent, session, "继续");
  assert.equal(continued.session.completed_steps.length, 9);
});
