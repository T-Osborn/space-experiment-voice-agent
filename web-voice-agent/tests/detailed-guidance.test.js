const test = require("node:test");
const assert = require("node:assert/strict");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { ProcedureRegistry, validateProcedures } = require("../server/procedure-registry");
const { extractStepInputs, parseUtc, parseIdentifier } = require("../server/spoken-inputs");
const { classifyVoiceIntent } = require("../server/voice-intents");
const { DialogueMemory } = require("../server/dialogue-memory");
const { riceReports } = require("../scripts/demo-inputs");
const rice = new ProcedureRegistry().procedures[0];
const turn = (agent, session, text) => agent.handleVoiceTurn({ session, recognized_text: text });
async function reach(index, agent = new AgentOrchestrator()) {
  let result = await turn(agent, agent.createSession(), "选择太空水稻实验");
  result = await turn(agent, result.session, "开始流程");
  for (let i = 0; i < index; i += 1) {
    result = await turn(agent, result.session, riceReports[i]);
    result = await turn(agent, result.session, "确认无误");
  }
  return { agent, session: result.session };
}

test("UTC reports validate calendar, reject local time and do not fabricate timestamps", () => {
  assert.equal(parseUtc("2026年10月7日08时30分00秒"), "2026-10-07T08:30:00Z");
  assert.equal(parseUtc("2024-02-29T00:00:00Z"), "2024-02-29T00:00:00Z");
  for (const text of ["已记录", "08:30", "2026-02-29T08:30:00Z", "2026-10-07T24:00:00Z",
    "2026-13-07T08:30:00Z", "2026-10-07T08:30:00+08:00", "北京时间2026年10月7日08时30分00秒"]) assert.equal(parseUtc(text), null, text);
});

test("identifiers are verbatim bounded records, not completion claims", () => {
  assert.equal(parseIdentifier("RICE-A01"), "RICE-A01");
  for (const text of ["已记录", "未记录", "不知道", "下一步", "A".repeat(65), "<script>", "A B"]) assert.equal(parseIdentifier(text), null, text);
  const report = extractStepInputs(rice.steps[2], "UTC时间戳已记录，设备编号已记录");
  assert.deepEqual(report.values, {});
  assert.deepEqual(report.ambiguous, ["sampling_utc", "equipment_id"]);
});

test("uncertain, negated or planned reports cannot satisfy present measurements", () => {
  for (const text of ["温度应该负八十", "温度不是负八十", "温度将为负八十", "温度不确定负八十"]) {
    assert.deepEqual(extractStepInputs(rice.steps[1], text).values, {}, text);
  }
  assert.equal(extractStepInputs(rice.steps[3], "方案核对没有完成").values.sampling_plan_checked, false);
  assert.equal(extractStepInputs(rice.steps[3], "方案核对没有核对完成").values.sampling_plan_checked, false);
  assert.deepEqual(extractStepInputs(rice.steps[3], "方案核对应该完成").values, {});
  for (const text of ["方案核对并非完成", "方案核对不是已完成", "方案核对不能确认完成"]) {
    assert.deepEqual(extractStepInputs(rice.steps[3], text).values, {});
  }
});

test("all detailed gates retain citations, gaps and operator-only provenance", async () => {
  const { agent, session } = await reach(8);
  const readback = await turn(agent, session, riceReports[8]);
  const completed = await turn(agent, readback.session, "确认无误");
  assert.equal(completed.session.completed_steps.length, 9);
  for (const record of Object.values(completed.session.step_records)) {
    assert.equal(record.evidence_status, "OPERATOR_REPORTED"); assert.equal(record.independently_verified, false);
    assert.ok(record.source_refs.length); assert.equal(record.procedure_version, rice.version);
  }
  assert.equal(completed.session.observations.equipment_id, "GBCM-01");
  assert.equal(completed.session.observations.container_id, "BOX-01");
  assert.equal(completed.session.observations.storage_utc, "2026-10-07T08:40:00Z");
  assert.equal(new ProcedureRegistry().list()[0].missing_detail_count, 15);
  assert.match(completed.speech_text, /不代表/u);
});

test("operation help identifies missing SOP methods without mutating a pending confirmation", async () => {
  const { agent, session } = await reach(3);
  const pending = await turn(agent, session, riceReports[3]);
  const help = await turn(agent, pending.session, "怎么剪取");
  assert.equal(help.response_type, "STEP_HELP"); assert.deepEqual(help.session, pending.session);
  assert.match(help.speech_text, /取样器具|部位/u);
});

test("actual alarms pause even when phrased as a question; hypotheticals remain read-only", async () => {
  const { agent, session } = await reach(1);
  const real = await turn(agent, session, "冷冻箱报警了怎么办？");
  assert.equal(real.response_type, "EXCEPTION_REPORTED"); assert.equal(real.session.last_exception.category, "EQUIPMENT");
  const hypothetical = await turn(agent, session, "如果冷冻箱报警了怎么办？");
  assert.deepEqual(hypothetical.session, session);
  const background = await turn(agent, session, "为什么样品污染会影响科学结果？");
  assert.deepEqual(background.session, session);
  for (const text of ["没有泄漏", "未发现污染", "无异常"]) assert.notEqual(classifyVoiceIntent(text), "EXCEPTION");
  assert.equal(classifyVoiceIntent("样品出现未知异常"), "EXCEPTION");
  const mixed = await turn(agent, session, "没有泄漏，但冷冻箱发生故障");
  assert.equal(mixed.session.status, "EXCEPTION_REPORTED");
});

test("exception detail collection is separate from scientific data and never unlocks a step", async () => {
  const { agent, session } = await reach(5);
  let result = await turn(agent, session, "样品标签不一致");
  assert.equal(result.session.last_exception.category, "IDENTITY");
  for (const text of ["受影响对象容器BOX-01", "异常现象标签与取样记录不一致", "已采取处置使用任务资料进行核对，暂未重新包装"]) {
    result = await turn(agent, result.session, text);
    assert.equal(result.response_type, "EXCEPTION_DETAILS_RECORDED");
    assert.equal(result.session.status, "EXCEPTION_REPORTED"); assert.deepEqual(result.session.observations, session.observations);
    assert.deepEqual(result.session.completed_steps, session.completed_steps);
  }
  assert.equal(result.session.last_exception.details.affected_item, "容器BOX-01");
  assert.match(result.speech_text, /尚|保持暂停|没有已审核/u);
  assert.equal((await turn(agent, result.session, "继续")).response_type, "RESUME_REQUIRES_CONFIRMATION");
});

test("unknown recovery and stale procedure versions cannot advance", async () => {
  const { agent, session } = await reach(1);
  const paused = await turn(agent, session, "冷冻箱故障");
  const guess = await turn(agent, paused.session, "异常已评估，恢复条件已满足，地面可能同意恢复流程");
  assert.equal(guess.session.status, "EXCEPTION_REPORTED");
  const stale = await turn(agent, { ...session, procedure_version: "old-v1" }, "温度负八十度");
  assert.equal(stale.response_type, "PROCEDURE_VERSION_MISMATCH"); assert.equal(stale.session.status, "PAUSED");
});

test("real-flight requests do not start unreviewed project configurations", async () => {
  const agent = new AgentOrchestrator();
  const selected = await turn(agent, agent.createSession(), "选择太空水稻实验");
  const result = await turn(agent, selected.session, "开始真实在轨实验");
  assert.equal(result.response_type, "PROCEDURE_REVIEW_REQUIRED"); assert.ok(!result.session.procedure_id);
});

test("schema validation rejects broken step chains, types, rules and unknown citations", () => {
  const sources = new Set(rice.steps.flatMap(step => [...step.source_refs,
    ...(step.rule_conflicts || []).flatMap(conflict => conflict.alternatives.map(rule => rule.source_ref))]));
  validateProcedures([rice], sources);
  for (const mutate of [
    (p) => { p.steps[0].next_step = "unknown"; }, (p) => { p.steps[0].required_inputs[0].type = "executable"; },
    (p) => { p.steps[0].source_refs = ["fabricated-source"]; },
    (p) => { p.steps[0].validation_rules = [{ field: "invented", operator: "present" }]; },
  ]) {
    const copy = structuredClone(rice); mutate(copy); assert.throws(() => validateProcedures([copy], sources));
  }
});

test("local paraphrases and pronoun follow-ups preserve task state and use the correct mission", async () => {
  const { agent, session } = await reach(1);
  const first = await turn(agent, session, "中国空间站2022年水稻实验耗时多久？");
  assert.equal(first.knowledge.top_record_id, "qa01_css_rice_duration");
  const followup = await turn(agent, session, "那次在哪些阶段取样？");
  assert.equal(followup.knowledge.top_record_id, "qa02_css_rice_sampling");
  assert.deepEqual(followup.session, session);
  const other = await turn(agent, session, "SJ-10水稻研究用了哪两个品种？");
  assert.equal(other.knowledge.top_record_id, "qa03_sj10_cultivars");
  assert.deepEqual(other.session, session);
  const official = await turn(agent, session, "NASA官方MELFI有几档温度？");
  assert.equal(official.knowledge.top_record_id, "qa06_melfi_setpoints");
});

test("historical sample preservation conflicts are disclosed rather than made into a transfer command", async () => {
  const agent = new AgentOrchestrator(); const session = agent.createSession();
  const result = await turn(agent, session, "2022年中国空间站水稻成熟种子保存条件是什么？");
  assert.equal(result.response_type, "SOURCE_CONFLICT"); assert.match(result.speech_text, /4摄氏度/u);
  assert.ok(result.knowledge.matched_records[0].sources.every((source) => source.id));
  assert.deepEqual(result.session, session);
  assert.equal((await turn(agent, session, "本次水稻样品该设为4度吗？")).response_type, "KNOWLEDGE_SOP_REQUIRED");
});

test("dialogue context expires, is bounded and cannot leak across sessions", () => {
  let now = 0; const memory = new DialogueMemory({ ttl: 10, limit: 1, now: () => now });
  const record = { match_groups: [["水稻"], ["2022"], ["多久"]] };
  memory.remember("a", record);
  assert.match(memory.resolve("a", "那次取样阶段？", []), /水稻 2022/u);
  assert.equal(memory.resolve("b", "那次取样阶段？", []), "那次取样阶段？");
  memory.remember("b", record); assert.equal(memory.entries.size, 1); assert.ok(!memory.entries.has("a"));
  now = 11; assert.equal(memory.resolve("b", "那次取样阶段？", []), "那次取样阶段？");
});
