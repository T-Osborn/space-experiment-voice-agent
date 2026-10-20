const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { KnowledgeRetriever } = require("../server/knowledge-retriever");
const { DialogueMemory } = require("../server/dialogue-memory");
const { behaviorPolicy, systemPrompt } = require("../server/behavior-policy");
const { SessionStore } = require("../server/deployment-security");
const { RecordRepository } = require("../server/record-repository");
const { createApp } = require("../server/app-server");

const say = (agent, session, recognized_text, extra = {}) => agent.handleVoiceTurn({ session, recognized_text, ...extra });
function makeAgent(options = {}) {
  return new AgentOrchestrator({ semanticAdapter: { select: async () => null }, ...options });
}
async function guiding(agent) {
  let result = await say(agent, agent.createSession(), "选择太空水稻实验");
  return (await say(agent, result.session, "开始流程")).session;
}

test("prompt rules require retrieval and missing-only clarification without enabling unverified operations", () => {
  assert.equal(behaviorPolicy.required_knowledge_retrieval, true);
  assert.match(systemPrompt, /强制调用|强制检索/u);
  assert.match(systemPrompt, /不重复询问已提供/u);
  assert.match(systemPrompt, /本轮不启用附件/u);
});

test("missing task context is clarified and a bare year re-runs retrieval without changing the experiment", async () => {
  const retriever = new KnowledgeRetriever();
  const calls = []; const search = retriever.search.bind(retriever);
  retriever.search = (query, limit) => { calls.push(query); return search(query, limit); };
  const agent = makeAgent({ knowledgeRetriever: retriever });
  const session = await guiding(agent); const before = structuredClone(session);
  const question = await say(agent, session, "水稻培养了多久");
  assert.equal(question.response_type, "KNOWLEDGE_CLARIFICATION");
  assert.match(question.speech_text, /为了给你更准确的建议，请告诉我/u);
  assert.match(question.speech_text, /任务|研究背景/u);
  assert.deepEqual(question.session, before);
  const answer = await say(agent, question.session, "2022年");
  assert.equal(answer.response_type, "KNOWLEDGE_ANSWER");
  assert.equal(answer.knowledge.top_record_id, "qa01_css_rice_duration");
  assert.deepEqual(answer.session, before);
  assert.equal(calls.length, 2); assert.match(calls[1], /水稻.*2022/u);
  assert.equal(answer.knowledge.retrieval_required, true);
  assert.equal(answer.conversation_context.pending, null);
});

test("an object then a task year can fill two successive missing scopes", async () => {
  const agent = makeAgent(); let session = agent.createSession();
  let result = await say(agent, session, "多久");
  assert.equal(result.response_type, "KNOWLEDGE_CLARIFICATION");
  assert.match(result.speech_text, /具体实验、设备或样品对象/u);
  result = await say(agent, result.session, "水稻");
  assert.equal(result.response_type, "KNOWLEDGE_CLARIFICATION");
  assert.match(result.speech_text, /任务或研究背景/u);
  assert.doesNotMatch(result.speech_text, /具体实验、设备或样品对象/u);
  result = await say(agent, result.session, "2022年中国空间站");
  assert.equal(result.response_type, "KNOWLEDGE_ANSWER");
  assert.equal(result.knowledge.top_record_id, "qa01_css_rice_duration");
  assert.deepEqual(result.session, session);
});

test("fully specified questions answer immediately and unsupported explicit years do not inherit a known year", async () => {
  const agent = makeAgent(); const session = agent.createSession();
  const known = await say(agent, session, "中国空间站2022年水稻全生命周期实验持续了多久");
  assert.equal(known.response_type, "KNOWLEDGE_ANSWER");
  assert.equal(known.knowledge.clarification, null);
  await say(agent, session, "水稻培养了多久");
  const unknown = await say(agent, session, "2020年");
  assert.equal(unknown.response_type, "KNOWLEDGE_MISSING");
  assert.equal(unknown.knowledge.top_record_id, null);
  assert.equal(unknown.knowledge.retrieval_status, "NO_MATCH");
});

test("an explicit choice resolves an ambiguous question but an invalid choice cannot select a record", async () => {
  const sources = [{ id: "fixture", title: "Software fixture only", url: "https://example.invalid/test" }];
  const records = ["甲", "乙"].map(label => ({ record_id: `fixture_${label}`, title: `测试主题${label}是什么？`,
    content: `隔离软件测试条目${label}，不是实验指导。`, questions: [`测试主题${label}是什么？`],
    direct_answer_allowed: true, source_ids: ["fixture"], match_groups: [["测试"], ["主题"]] }));
  const agent = makeAgent({ knowledgeRetriever: new KnowledgeRetriever({ records, sources }) });
  const session = agent.createSession();
  assert.equal((await say(agent, session, "测试主题")).response_type, "KNOWLEDGE_CLARIFICATION");
  assert.equal((await say(agent, session, "第三个")).response_type, "KNOWLEDGE_CLARIFICATION");
  const chosen = await say(agent, session, "第二个");
  assert.equal(chosen.response_type, "KNOWLEDGE_ANSWER");
  assert.equal(chosen.knowledge.top_record_id, "fixture_乙");
  assert.deepEqual(chosen.session, session);
});

test("real reports, confirmations and fault reports remain in the task route during clarification", async () => {
  const agent = makeAgent(); const session = await guiding(agent);
  await say(agent, session, "水稻培养了多久");
  const report = await say(agent, session, "培养周期九十五天");
  assert.equal(report.response_type, "STEP_WAITING_INPUT");
  assert.equal(report.session.step_observations.cultivation_days, 95);
  assert.equal(report.conversation_context.pending, null);
  await say(agent, report.session, "水稻培养了多久");
  const confirmation = await say(agent, report.session, "确认无误");
  assert.notEqual(confirmation.response_type, "KNOWLEDGE_ANSWER");
  assert.equal(confirmation.session.completed_steps.length, 0);
  const fault = await say(agent, report.session, "冷冻箱发生故障");
  assert.equal(fault.session.status, "EXCEPTION_REPORTED");
  assert.equal(fault.conversation_context.pending, null);
});

test("read-only status and an operator pause keep the clarification while cancellation ends it", async () => {
  const agent = makeAgent(); const session = await guiding(agent);
  await say(agent, session, "水稻培养了多久");
  const status = await say(agent, session, "当前状态");
  assert.ok(status.conversation_context.pending);
  const paused = await say(agent, status.session, "暂停流程");
  const answer = await say(agent, paused.session, "2022年");
  assert.equal(answer.response_type, "KNOWLEDGE_ANSWER");
  assert.equal(answer.session.status, "PAUSED");
  assert.equal(answer.session.current_step, session.current_step);
  await say(agent, answer.session, "水稻培养了多久");
  const cancelled = await say(agent, answer.session, "取消追问");
  assert.equal(cancelled.response_type, "KNOWLEDGE_QUERY_CANCELLED");
  assert.deepEqual(cancelled.session, answer.session);
  assert.equal(cancelled.conversation_context.pending, null);
});

test("retrieval failures never call the model or answer from memory", async () => {
  for (const [retriever, expected] of [
    [null, "UNCONNECTED"],
    [{ getStatus: () => ({ available: false, status: "UNAVAILABLE" }), search() { throw new Error("not called"); } }, "UNAVAILABLE"],
    [{ search() { throw new Error("private fixture failure"); } }, "FAILED"],
  ]) {
    let modelCalls = 0;
    const agent = makeAgent({ knowledgeRetriever: retriever, semanticAdapter: { select() { modelCalls++; } } });
    const session = agent.createSession(); const result = await say(agent, session, "水稻培养了多久");
    assert.equal(result.knowledge.retrieval_status, expected);
    assert.equal(modelCalls, 0); assert.deepEqual(result.session, session);
    assert.doesNotMatch(result.speech_text, /private fixture|不在.*知识库范围/u);
  }
});

test("clearly unsupported facts return no-match instead of repeatedly requesting irrelevant fields", async () => {
  const agent = makeAgent(); const session = agent.createSession();
  for (const question of ["水稻叶片含氮量是多少", "蛋白质结晶的缓冲液配方是什么"]) {
    const result = await say(agent, session, question);
    assert.equal(result.response_type, "KNOWLEDGE_MISSING", question);
    assert.equal(result.knowledge.retrieval_status, "NO_MATCH");
  }
});

test("telemetry and task safety boundaries still prohibit paper-derived measurements or clearance", async () => {
  const agent = makeAgent(); const session = agent.createSession();
  await say(agent, session, "多久");
  for (const [query, expected] of [["当前温度是多少", "KNOWLEDGE_NO_TELEMETRY"], ["这个实验可以继续吗", "KNOWLEDGE_SOP_REQUIRED"]]) {
    assert.equal((await say(agent, session, query)).response_type, expected);
  }
});

test("vague follow-ups ask for a topic and explicit report aliases cannot be consumed as clarification", async () => {
  const agent = makeAgent(); const session = await guiding(agent);
  await say(agent, session, "SJ-10水稻代谢组学研究用了哪两个品种？");
  const vague = await say(agent, session, "那么它呢");
  assert.equal(vague.response_type, "KNOWLEDGE_CLARIFICATION");
  assert.ok(vague.knowledge.clarification.choices.length);
  await say(agent, session, "多久");
  const report = await say(agent, session, "成熟度评估已完成");
  assert.equal(report.response_type, "STEP_WAITING_INPUT");
  assert.equal(report.session.step_observations.seed_maturity_assessed, true);
});

test("a routed model cannot answer without eligible retrieved records", async () => {
  const retriever = new KnowledgeRetriever();
  let searches = 0;
  retriever.search = () => { searches++; return []; };
  const agent = makeAgent({ knowledgeRetriever: retriever, semanticAdapter: { select: async () => ({
    decision: "MATCH", record_id: "invented_record", evidence_quote: "SJ-10", answer: "Never speak this generated claim",
  }) } });
  const result = await say(agent, agent.createSession(), "SJ-10那两个名字是什么？");
  assert.equal(searches, 1);
  assert.equal(result.response_type, "KNOWLEDGE_MISSING");
  assert.doesNotMatch(result.speech_text, /Never speak/u);
});

test("clarification memory is isolated, expires, and is reset by an authoritative empty committed context", async () => {
  let clock = 0;
  const memory = new DialogueMemory({ ttl: 10, now: () => clock });
  const agent = makeAgent({ dialogueMemory: memory });
  const first = agent.createSession(); const second = agent.createSession();
  await say(agent, first, "水稻培养了多久");
  assert.equal(memory.pending(second.session_id), null);
  clock = 11;
  assert.equal(memory.pending(first.session_id), null);
  await say(agent, first, "水稻培养了多久");
  const restored = await say(agent, first, "2022年", { conversation_context: null });
  assert.notEqual(restored.response_type, "KNOWLEDGE_ANSWER");
});

test("pending questions survive a closed SQLite repository without modifying experiment data", async t => {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, "voice-clarification-test-"));
  let repository;
  t.after(() => {
    repository?.close();
    assert.equal(path.dirname(directory), parent); assert.match(path.basename(directory), /^voice-clarification-test-/u);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  repository = new RecordRepository({ directory });
  let store = new SessionStore({ repository }); let agent = makeAgent();
  let session = store.create("owner", await guiding(agent));
  const turn = (query) => store.turn(session.session_id, "owner", (saved, reply) => say(agent, saved, query,
    { conversation_context: reply?.conversation_context || null }));
  const question = await turn("水稻培养了多久");
  assert.equal(question.response_type, "KNOWLEDGE_CLARIFICATION");
  repository.close(); repository = new RecordRepository({ directory });
  store = new SessionStore({ repository }); agent = makeAgent();
  const answer = await turn("2022年");
  assert.equal(answer.response_type, "KNOWLEDGE_ANSWER");
  assert.equal(answer.knowledge.top_record_id, "qa01_css_rice_duration");
  assert.deepEqual(answer.session.step_observations, question.session.step_observations);
  assert.equal(answer.session.current_step, question.session.current_step);
  assert.throws(() => store.get(session.session_id, "another-owner"), /NOT_FOUND/u);
});

test("HTTP clarification accepts a short reply after a status query using the committed dialogue context", async t => {
  const { server } = createApp({ env: { RECORD_STORAGE: "memory" }, orchestrator: makeAgent() });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const grant = await fetch(base + "/api/access", { method: "POST", headers: { "X-Voice-Agent-Request": "1", "Content-Type": "application/json" }, body: "{}" });
  const headers = { Cookie: grant.headers.get("set-cookie").split(";")[0], "X-Voice-Agent-Request": "1", "Content-Type": "application/json" };
  const session = await (await fetch(base + "/api/session", { method: "POST", headers, body: "{}" })).json();
  const turn = async recognized_text => {
    const response = await fetch(base + "/api/voice/turn", { method: "POST", headers, body: JSON.stringify({ session_id: session.session_id, recognized_text }) });
    assert.equal(response.status, 200); return response.json();
  };
  await turn("选择太空水稻实验"); await turn("开始流程");
  const question = await turn("水稻培养了多久");
  assert.equal(question.response_type, "KNOWLEDGE_CLARIFICATION");
  await turn("当前状态");
  const answer = await turn("2022年");
  assert.equal(answer.response_type, "KNOWLEDGE_ANSWER");
  assert.equal(answer.knowledge.top_record_id, "qa01_css_rice_duration");
  assert.equal(answer.session.current_step, question.session.current_step);
  assert.deepEqual(answer.session.step_observations, question.session.step_observations);
});
