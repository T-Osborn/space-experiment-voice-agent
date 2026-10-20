const test = require("node:test");
const assert = require("node:assert/strict");
const { parseUtc, extractStepInputs } = require("../server/spoken-inputs");
const { ProcedureRegistry } = require("../server/procedure-registry");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { riceReports } = require("../scripts/demo-inputs");

const rice = new ProcedureRegistry().procedures[0];
const turn = (agent, session, text) => agent.handleVoiceTurn({ session, recognized_text: text });
async function reach(index) {
  const agent = new AgentOrchestrator();
  let result = await turn(agent, agent.createSession(), "选择太空水稻实验");
  result = await turn(agent, result.session, "开始流程");
  for (let i = 0; i < index; i += 1) {
    result = await turn(agent, result.session, riceReports[i]);
    assert.equal(result.response_type, "STEP_AWAITING_CONFIRMATION");
    result = await turn(agent, result.session, "确认无误");
  }
  return { agent, session: result.session };
}

test("UTC accepts complete Arabic, Chinese and mixed-component speech formats", () => {
  for (const text of [
    "2026年10月7日8时30分0秒",
    "二零二六年十月七日八时三十分零秒",
    "二〇二六年十月七号八点三十分零秒",
    "二千零二十六年十月七日八时三十分零秒",
    "2026年十月7日八点30分零秒",
    "UTC 2026 年 10 月 7 日，8 点 30 分 0 秒。",
    "2026年10月7日。8时30分0秒",
    "2026年10月7日8:30:00",
    "２０２６年１０月７日８：３０：００",
    "2026年10月7日\n8时30分0秒 UTC",
    "UTC时间2026年10月7日8时30分0秒",
    "2026-10-07T08:30:00Z",
  ]) assert.equal(parseUtc(text), "2026-10-07T08:30:00Z", text);
  assert.equal(parseUtc("二零二四年二月二十九日零时零分零秒"), "2024-02-29T00:00:00Z");
});

test("UTC rejects incomplete, invalid, ambiguous and local timestamps", () => {
  for (const text of [
    "2026年10月7日8点30分", "十月七日八时三十分零秒", "2026年10月7日早上8时30分0秒",
    "北京时间2026年10月7日8时30分0秒", "2026-10-07T08:30:00+08:00",
    "2026年10月7日8时30分0秒+08:00", "2026年10月7日8:30", "2026年10月7日8点半",
    "二零二六年二月二十九日八时三十分零秒", "2026年13月7日8时30分0秒",
    "2026年10月32日8时30分0秒", "2026年10月7日24时0分0秒",
    "2026年10月7日8时60分0秒", "2026年10月7日8时30分60秒",
    "2026年10月7日八时三十分零秒，或者九时三十分零秒",
    "2026年10月7日八时三十分零秒，时间不确定",
    "2026年10月7日八时三十分零秒，2026年10月7日九时三十分零秒",
    "二零二六年十月七日八时一百五分零秒", "2026年10月7日8.5时30分0秒",
    "二零二十六月七日八时三十分零秒", "202年10月7日8时30分0秒",
    "二千零二十六十月七日八时三十分零秒",
    "二零二六十月七日八时30分零秒",
    "", "已记录", null, undefined,
  ]) assert.equal(parseUtc(text), null, String(text));
});

test("timestamp fields retain ASR date punctuation but never consume adjacent identifiers", () => {
  for (const text of [
    "UTC时间二零二六年十月七日八时三十分零秒，设备编号GBCM-01。",
    "UTC时间2026年10月7日，8点30分0秒，设备编号GBCM-01。",
    "设备编号GBCM-01，UTC时间2026年10月7日8:30:00。",
    "UTC时间戳为２０２６年１０月７日，８点３０分０秒；设备编号GBCM-01。",
  ]) assert.deepEqual(extractStepInputs(rice.steps[2], text), {
    values: { sampling_utc: "2026-10-07T08:30:00Z", equipment_id: "GBCM-01" }, ambiguous: [],
  }, text);
  assert.deepEqual(extractStepInputs(rice.steps[2], "二零二六年十月七日八时三十分零秒。", { equipment_id: "GBCM-01" }), {
    values: { sampling_utc: "2026-10-07T08:30:00Z" }, ambiguous: [],
  });
});

test("T's exact ASR transcript extracts the UTC time without inventing an equipment suffix", () => {
  const report = extractStepInputs(rice.steps[2], "Utc时间二零二六年十月七日八时30分零秒", { equipment_id: "gbcm" });
  assert.deepEqual(report, { values: { sampling_utc: "2026-10-07T08:30:00Z" }, ambiguous: [] });
  // A separately transcribed identifier is never repaired from the demo script.
  assert.deepEqual(extractStepInputs(rice.steps[2], "设备编号gbcm。"), {
    values: { equipment_id: "gbcm" }, ambiguous: [],
  });
});

test("a conflicting timestamp invalidates only its field, including text after punctuation", () => {
  for (const text of [
    "UTC时间2026年10月7日8时30分0秒，或者2026年10月7日9时30分0秒，设备编号GBCM-01",
    "UTC时间2026年10月7日8时30分0秒，UTC时间2026年10月7日9时30分0秒，设备编号GBCM-01",
    "UTC时间2026年10月7日8时30分0秒，时间不确定，设备编号GBCM-01",
  ]) assert.deepEqual(extractStepInputs(rice.steps[2], text), {
    values: { equipment_id: "GBCM-01" }, ambiguous: ["sampling_utc"],
  }, text);
});

test("step 3 accepts a time-only retry, keeps earlier steps and equipment, then requires readback confirmation", async () => {
  const { agent, session } = await reach(2);
  const incomplete = await turn(agent, session, "UTC时间2026年10月7日8点30分，设备编号GBCM-01");
  assert.equal(incomplete.response_type, "STEP_INPUT_AMBIGUOUS");
  assert.equal(incomplete.session.step_observations.equipment_id, "GBCM-01");
  const retry = await turn(agent, incomplete.session, "Utc时间二零二六年十月七日八时30分零秒");
  assert.equal(retry.response_type, "STEP_AWAITING_CONFIRMATION");
  assert.equal(retry.session.current_step, rice.steps[2].step_id);
  assert.deepEqual(retry.session.completed_steps, session.completed_steps);
  assert.deepEqual(retry.session.step_observations, { sampling_utc: "2026-10-07T08:30:00Z", equipment_id: "GBCM-01" });
  assert.match(retry.speech_text, /2026年10月07日08时30分00秒，UTC/u);
  const confirmed = await turn(agent, retry.session, "确认无误");
  assert.equal(confirmed.session.current_step, rice.steps[3].step_id);
  assert.equal(confirmed.session.completed_steps.length, 3);
});

test("time questions do not mutate a task or bypass independent confirmation on corrections", async () => {
  const { agent, session } = await reach(2);
  const report = await turn(agent, session, "UTC时间二零二六年十月七日八时三十分零秒，设备编号GBCM-01");
  const question = await turn(agent, report.session, "UTC时间二零二六年十月七日八时三十分零秒是什么意思？");
  assert.deepEqual(question.session, report.session);
  const corrected = await turn(agent, report.session, "更正UTC时间2026年10月7日8:31:00");
  assert.equal(corrected.response_type, "STEP_AWAITING_CONFIRMATION");
  assert.equal(corrected.session.step_observations.sampling_utc, "2026-10-07T08:31:00Z");
  const invalid = await turn(agent, corrected.session, "更正UTC时间2026年10月7日8点32分");
  assert.equal(invalid.response_type, "STEP_INPUT_AMBIGUOUS");
  assert.equal(invalid.session.step_observations.sampling_utc, undefined);
  assert.equal(invalid.session.pending_confirmation, null);
  assert.equal((await turn(agent, invalid.session, "确认无误")).response_type, "STEP_WAITING_INPUT");
});

test("step 8 uses the same UTC parser and keeps saved-result gates", async () => {
  const { agent, session } = await reach(7);
  const report = await turn(agent, session, "样品保存已完成，保存UTC时间二零二六年十月七日，八点四十分零秒，目标位置核对已完成");
  assert.equal(report.response_type, "STEP_AWAITING_CONFIRMATION");
  assert.equal(report.session.current_step, rice.steps[7].step_id);
  assert.equal(report.session.step_observations.storage_utc, "2026-10-07T08:40:00Z");
  const confirmed = await turn(agent, report.session, "确认无误");
  assert.equal(confirmed.session.current_step, rice.steps[8].step_id);
});
