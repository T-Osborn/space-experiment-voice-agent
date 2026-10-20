const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { KnowledgeRetriever } = require("../server/knowledge-retriever");
const { ProcedureEngine } = require("../server/procedure-engine");
const { ProcedureRegistry, validateProcedures } = require("../server/procedure-registry");
const { classifyVoiceIntent } = require("../server/voice-intents");
const { RecordRepository } = require("../server/record-repository");
const { SessionStore } = require("../server/deployment-security");
const { createApp } = require("../server/app-server");
const { riceReports } = require("../scripts/demo-inputs");

const question = "NASA的流体与燃烧设施FCF由哪些实验柜组成？";
function agent(options = {}) {
  return new AgentOrchestrator({ semanticAdapter: { getPublicConfig: () => ({ configured: false }), select: async () => null }, ...options });
}
const say = (instance, session, recognized_text) => instance.handleVoiceTurn({ session, recognized_text });
async function reach(count = 0) {
  const instance = agent();
  let response = await say(instance, instance.createSession(), "选择太空水稻实验");
  response = await say(instance, response.session, "开始流程");
  for (const report of riceReports.slice(0, count)) {
    response = await say(instance, response.session, report);
    response = await say(instance, response.session, "确认无误");
  }
  return { instance, session: response.session };
}

test("V2 professional questions preserve selected, active, operator-paused and exception-paused tasks", async () => {
  const { instance, session } = await reach(1);
  const paused = (await say(instance, session, "暂停流程")).session;
  const exception = (await say(instance, session, "冷冻箱发生故障")).session;
  const selected = (await say(instance, instance.createSession(), "选择蛋白质结晶实验")).session;
  for (const state of [selected, session, paused, exception]) {
    const answer = await say(instance, state, question);
    assert.equal(answer.response_type, "KNOWLEDGE_ANSWER");
    assert.equal(answer.knowledge.retrieval_status, "MATCHED");
    assert.deepEqual(answer.session, state);
    assert.match(answer.speech_text, /燃烧|流体/u);
  }
  assert.equal(classifyVoiceIntent("我想了解FCF的作用"), "KNOWLEDGE");
  assert.equal(classifyVoiceIntent("容器污染通常有哪些研究"), "KNOWLEDGE");
});

test("V2 missing-input request combines only missing fields and retains partial multi-field reports", async () => {
  const { instance, session } = await reach();
  const partial = await say(instance, session, "培养周期九十五天");
  assert.equal(partial.session.step_observations.cultivation_days, 95);
  const missingRequest = partial.speech_text.split("请补充：")[1];
  assert.ok(missingRequest);
  assert.match(missingRequest, /成熟度评估|种子是否成熟|营养液/u);
  assert.doesNotMatch(missingRequest, /周期天数/u);
  assert.equal(partial.progress.reported.length, 1); assert.equal(partial.progress.missing.length, 3);
  const completed = await say(instance, partial.session, "成熟度评估已完成，种子已成熟，营养液剩余百分之二十五");
  assert.equal(completed.response_type, "STEP_AWAITING_CONFIRMATION");
  assert.equal(completed.progress.missing.length, 0); assert.equal(completed.progress.reported.length, 4);
  assert.equal(completed.session.completed_steps.length, 0);
});

test("V2 explicit wrong units are clarified without overwriting valid fields", async () => {
  const { instance, session } = await reach();
  const result = await say(instance, session, "培养周期九十五小时，成熟度评估已完成，种子已成熟，营养液剩余百分之二十五");
  assert.equal(result.response_type, "STEP_INPUT_AMBIGUOUS");
  assert.equal(result.session.step_observations.cultivation_days, undefined);
  assert.equal(result.session.step_observations.nutrient_remaining_percent, 25);
  const corrected = await say(instance, result.session, "培养周期九十五天");
  assert.equal(corrected.response_type, "STEP_AWAITING_CONFIRMATION");
  const temperatureStep = (await say(instance, corrected.session, "确认无误")).session;
  for (const text of ["温度负八十华氏度", "负八十华氏度", "温度八十厘米", "温度负80F", "温度负80℉", "负八十开尔文"]) {
    const bad = await say(instance, temperatureStep, text);
    assert.equal(bad.response_type, "STEP_INPUT_AMBIGUOUS", text);
    assert.equal(bad.session.step_observations.melfi_temperature_c, undefined);
  }
  const correct = await say(instance, temperatureStep, "温度负八十点零五摄氏度");
  assert.equal(correct.session.step_observations.melfi_temperature_c, -80.05);
});

test("V2 contradictory boolean reports require clarification rather than silently choosing a value", async () => {
  const { instance, session } = await reach();
  const result = await say(instance, session, "培养周期九十五天，成熟度评估未完成但已完成，种子已成熟，营养液剩余百分之二十五");
  assert.equal(result.response_type, "STEP_INPUT_AMBIGUOUS");
  assert.equal(result.session.step_observations.seed_maturity_assessed, undefined);
  assert.equal(result.session.step_observations.cultivation_days, 95);
});

test("V2 90-day boundary conflicts differ from definitely failing and definitely passing values", async () => {
  for (const [days, type] of [[89, "VALIDATION_FAILED"], [90, "STEP_RULE_CONFLICT"], [91, "STEP_AWAITING_CONFIRMATION"]]) {
    const { instance, session } = await reach();
    const result = await say(instance, session, `培养周期${days}天，成熟度评估已完成，种子已成熟，营养液剩余百分之二十五`);
    assert.equal(result.response_type, type);
    if (days === 90) {
      assert.equal(result.session.pause_reason, "RULE_CONFLICT");
      assert.deepEqual(result.session.unresolved_conflicts[0].alternatives.map(rule => rule.operator), [">", ">="]);
      assert.match(result.speech_text, /90|冲突|表述差异/u);
      assert.equal(result.progress.decision, "资料冲突，暂不能判定");
    }
  }
  const { instance, session } = await reach();
  const otherFailure = await say(instance, session, "培养周期九十天，成熟度评估已完成，种子未成熟，营养液剩余百分之二十五");
  assert.equal(otherFailure.response_type, "VALIDATION_FAILED");
});

test("V2 unresolved rule conflicts cannot be cleared by confirming, resuming, rechecking or changing the value", async () => {
  const { instance, session } = await reach();
  const conflict = await say(instance, session, "培养周期九十天，成熟度评估已完成，种子已成熟，营养液剩余百分之二十五");
  for (const text of ["确认无误", "继续", "恢复流程", "培养周期九十五天", "重新核对本步骤",
    "异常已评估，恢复条件已满足，地面同意恢复流程"]) {
    const result = await say(instance, conflict.session, text);
    assert.equal(result.session.status, "PAUSED", text);
    assert.equal(result.session.current_step, "cultivation_state_check");
    assert.deepEqual(result.session.unresolved_conflicts, conflict.session.unresolved_conflicts);
    assert.equal(result.session.completed_steps.length, 0);
  }
  assert.deepEqual((await say(instance, conflict.session, question)).session, conflict.session);
});

test("V2 normal pause resumes to the same pending confirmation and negated commands do not resume", async () => {
  const { instance, session } = await reach(1);
  const pending = await say(instance, session, riceReports[1]);
  const paused = await say(instance, pending.session, "暂停流程");
  assert.equal(paused.progress.next_action, "说恢复流程回到原步骤");
  const negated = await say(instance, paused.session, "不要恢复流程");
  assert.deepEqual(negated.session, paused.session);
  const resumed = await say(instance, negated.session, "恢复流程");
  assert.equal(resumed.session.status, "GUIDING");
  assert.equal(resumed.session.step_state, "WAITING_STEP_CONFIRMATION");
  assert.deepEqual(resumed.session.step_observations, pending.session.step_observations);
  assert.equal(resumed.session.completed_steps.length, 1);
});

test("V2 label-visibility problems trigger an identity pause while hypothetical questions do not", async () => {
  const { instance, session } = await reach(5);
  const exception = await say(instance, session, "容器标签看不清");
  assert.equal(exception.session.status, "EXCEPTION_REPORTED");
  assert.equal(exception.session.last_exception.category, "IDENTITY");
  assert.equal(exception.progress.paused, true);
  const hypothetical = await say(instance, session, "如果容器标签看不清怎么办");
  assert.deepEqual(hypothetical.session, session);
  assert.equal((await say(instance, exception.session, "继续")).session.status, "EXCEPTION_REPORTED");
});

test("V2 abnormal recovery requires an applicable configured instruction and logs operator evidence accurately", async () => {
  const { instance, session } = await reach(1);
  const failure = await say(instance, session, "温度负六十度");
  const unsupported = await say(instance, failure.session, "异常已评估，恢复条件已满足，地面同意恢复流程");
  assert.equal(unsupported.session.status, "PAUSED");
  assert.equal(unsupported.session.pending_resume_basis.verification_status, "UNVERIFIED");
  // Isolated software fixture; this instruction is never added to production configuration.
  const procedure = structuredClone(instance.procedureRegistry.procedures[0]);
  procedure.recovery_policy = { approval_status: "APPROVED", instructions: [
    { id: "TEST-REC-01", source_refs: ["test-fixture-only"], step_ids: ["melfi_storage_check"] },
  ] };
  const engine = new ProcedureEngine();
  for (const id of ["UNKNOWN", "TEST-REC-01-extra"]) {
    const bad = engine.handleInput(failure.session, procedure, `异常已评估，恢复条件已满足，地面同意恢复流程，地面指令编号${id}`);
    assert.equal(bad.session.status, "PAUSED");
  }
  const restored = engine.handleInput(failure.session, procedure, "异常已评估，恢复条件已满足，地面同意恢复流程，地面指令编号TEST-REC-01");
  assert.equal(restored.session.status, "GUIDING");
  assert.deepEqual(restored.session.step_observations, {});
  assert.equal(restored.session.event_log.at(-1).data.instruction_id, "TEST-REC-01");
  assert.equal(restored.session.event_log.at(-1).data.independently_verified, false);
});

test("V2 knowledge no-match, unconnected, unavailable and failed states remain distinct", async () => {
  const cases = [
    [new KnowledgeRetriever({ records: [], sources: [] }), "KNOWLEDGE_MISSING", "NO_MATCH"],
    [null, "KNOWLEDGE_UNAVAILABLE", "UNCONNECTED"],
    [new KnowledgeRetriever({ load: () => { throw new Error("FIXTURE_LOAD_FAILURE"); } }), "KNOWLEDGE_UNAVAILABLE", "UNAVAILABLE"],
    [{ records: [], search: () => { throw new Error("PRIVATE_FIXTURE_DO_NOT_EXPOSE"); } }, "KNOWLEDGE_RETRIEVAL_FAILED", "FAILED"],
    [{ records: [], search: async () => { throw new Error("PRIVATE_FIXTURE_DO_NOT_EXPOSE"); } }, "KNOWLEDGE_RETRIEVAL_FAILED", "FAILED"],
  ];
  const active = (await reach(1)).session;
  for (const [knowledgeRetriever, type, status] of cases) {
    const instance = agent({ knowledgeRetriever });
    const result = await say(instance, active, question);
    assert.equal(result.response_type, type); assert.equal(result.knowledge.retrieval_status, status);
    assert.deepEqual(result.session, active);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE_DO_NOT_EXPOSE|FIXTURE_LOAD_FAILURE/u);
    if (status !== "NO_MATCH") assert.doesNotMatch(result.speech_text, /未检索到明确答案|知识库没有答案/u);
  }
});

test("V2 optional semantic failure does not misreport a completed local search as failed", async () => {
  const instance = agent({ knowledgeRetriever: new KnowledgeRetriever({ records: [], sources: [] }),
    semanticAdapter: { getPublicConfig: () => ({}), select: async () => { throw new Error("FIXTURE_OPTIONAL_MODEL"); } } });
  const result = await say(instance, instance.createSession(), question);
  assert.equal(result.knowledge.retrieval_status, "NO_MATCH");
  assert.equal(result.knowledge.semantic_status, "FAILED");
});

test("V2 help supplies existing question examples, and unrelated requests preserve tasks", async () => {
  const { instance, session } = await reach(1);
  const help = await say(instance, session, "语音帮助");
  assert.match(help.speech_text, /专业知识可以直接提问/u);
  assert.match(help.speech_text, /2022年水稻全生命周期/u);
  assert.deepEqual(help.session, session);
  const unrelated = await say(instance, session, "给我讲个笑话");
  assert.equal(unrelated.response_type, "OUT_OF_SCOPE"); assert.deepEqual(unrelated.session, session);
});

test("V2 conflict metadata and unverified recovery evidence survive a closed SQLite repository", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voice-v2-state-"));
  let repository;
  t.after(() => { repository?.close(); assert.ok(path.basename(directory).startsWith("voice-v2-state-")); fs.rmSync(directory, { recursive: true, force: true }); });
  repository = new RecordRepository({ directory });
  const instance = agent(); let store = new SessionStore({ repository });
  let session = store.create("v2-owner", instance.createSession());
  for (const text of ["选择太空水稻实验", "开始流程", "培养周期九十天，成熟度评估已完成，种子已成熟，营养液剩余百分之二十五",
    "异常已评估，恢复条件已满足，地面同意恢复流程"]) {
    session = (await store.turn(session.session_id, "v2-owner", saved => say(instance, saved, text))).session;
  }
  repository.close(); repository = new RecordRepository({ directory }); store = new SessionStore({ repository });
  const restored = store.create("v2-owner", instance.createSession());
  assert.deepEqual(restored, session);
  assert.equal(restored.unresolved_conflicts.length, 1);
  assert.equal(restored.pending_resume_basis.verification_status, "UNVERIFIED");
  const progress = instance.procedureEngine.progress(restored, instance.procedureRegistry.procedures[0]);
  assert.equal(progress.paused, true); assert.equal(progress.reported.length, 4);
});

test("V2 invalid conflict and recovery references fail configuration validation", () => {
  const registry = new ProcedureRegistry();
  const procedure = structuredClone(registry.procedures[0]);
  const sources = new Set(procedure.source_refs.concat(["project_skill_v2_2026_10_15", "official_cas_rice_2022", "nasa_melfi_official", "project_traceability_design_2026_10_07"]));
  procedure.steps[0].rule_conflicts[0].alternatives[0].source_ref = "missing-source";
  assert.throws(() => validateProcedures([procedure], sources), /CONFLICT_INVALID/u);
});

test("V2 HTTP knowledge failures are usable responses and restored progress enforces ownership", async t => {
  const instance = agent(); const app = createApp({ orchestrator: instance });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = "";
  const request = (route, body, selectedCookie = cookie) => fetch(base + route, {
    method: body === undefined ? "GET" : "POST", headers: { Cookie: selectedCookie,
      "Content-Type": "application/json", "X-Voice-Agent-Request": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const access = await request("/api/access", {}); cookie = access.headers.get("set-cookie").split(";")[0];
  let session = await (await request("/api/session", {})).json();
  for (const text of ["选择太空水稻实验", "开始流程", "培养周期九十五天"]) {
    const response = await (await request("/api/voice/turn", { session_id: session.session_id, recognized_text: text })).json();
    session = response.session;
  }
  const before = structuredClone(session);
  const progress = await (await request(`/api/progress?session_id=${session.session_id}`)).json();
  assert.equal(progress.progress.reported[0].value, 95); assert.equal(progress.progress.missing.length, 3);
  assert.deepEqual(await (await request("/api/session", {})).json(), before);
  const strangerAccess = await request("/api/access", {}, "");
  const strangerCookie = strangerAccess.headers.get("set-cookie").split(";")[0];
  assert.equal((await request(`/api/progress?session_id=${session.session_id}`, undefined, strangerCookie)).status, 404);
  instance.knowledgeRetriever.search = () => { throw new Error("PRIVATE_FIXTURE_DO_NOT_EXPOSE"); };
  const failedResponse = await request("/api/voice/turn", { session_id: session.session_id, recognized_text: question });
  assert.equal(failedResponse.status, 200);
  const failed = await failedResponse.json(); assert.equal(failed.response_type, "KNOWLEDGE_RETRIEVAL_FAILED");
  assert.deepEqual(failed.session.step_observations, before.step_observations);
  const inspected = await (await request("/api/knowledge/search?q=FCF")).json();
  assert.equal(inspected.retrieval_status, "FAILED");
  assert.deepEqual(inspected.results, []);
});
