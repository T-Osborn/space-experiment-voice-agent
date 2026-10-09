const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { KnowledgeRetriever, knowledgeBoundary, normalizeQuestion } = require("../server/knowledge-retriever");
const { AgentOrchestrator } = require("../server/agent-orchestrator");

const kb = path.join(__dirname, "..", "..", "knowledge_base");
const read = (file) => JSON.parse(fs.readFileSync(path.join(kb, file), "utf8"));
const core = read("qa-core.json");
const retriever = new KnowledgeRetriever();

for (const record of core) {
  test(`${record.record_id}: canonical and two paraphrases retain correct sources`, async () => {
    const agent = new AgentOrchestrator();
    for (const question of record.questions) {
      // ASR often omits punctuation. These are simulated transcripts, not recorded audio.
      const text = question.replace(/[？?]/gu, "");
      const found = retriever.search(`请问${text}`);
      assert.equal(found[0]?.record_id, record.record_id, question);
      assert.equal(found[0].match_type, "EXACT_QUESTION");
      assert.deepEqual(found[0].sources.map((source) => source.id), record.source_ids);
      assert.equal(found[0].execution_allowed, false);
      const result = await agent.handleVoiceTurn({ session: agent.createSession(), recognized_text: text });
      assert.equal(result.knowledge.top_record_id, record.record_id, question);
      assert.equal(result.response_type, record.record_type === "source_conflict" ? "SOURCE_CONFLICT" : "KNOWLEDGE_ANSWER");
      assert.ok(result.speech_text.includes(record.content));
      assert.ok(result.speech_text.includes(record.spoken_citation));
      assert.ok(!result.speech_text.includes("undefined"));
    }
  });
}

test("blocked answers, missing citations and unverified candidates cannot be retrieved", () => {
  const sources = [{ id: "official", title: "Fixture", url: "https://example.com/fixture" }];
  const base = { title: "Fixture", content: "禁止播报的候选", questions: ["测试问题"], match_groups: [["测试"], ["问题"]] };
  const records = [
    { ...base, record_id: "blocked", direct_answer_allowed: false, source_ids: ["official"] },
    { ...base, record_id: "missing", direct_answer_allowed: true, source_ids: ["missing"] },
    { ...base, record_id: "partial", direct_answer_allowed: true, source_ids: ["official", "missing"] },
    { ...base, record_id: "empty", direct_answer_allowed: true, source_ids: [] },
    { ...base, record_id: "unverified", direct_answer_allowed: true, review_status: "UNVERIFIED_PROJECT_CANDIDATE", source_ids: ["official"] },
  ];
  assert.deepEqual(new KnowledgeRetriever({ records, sources }).search("测试问题"), []);
  const agent = new AgentOrchestrator();
  assert.equal(agent.composeKnowledgeResponse({ query: "测试问题", results: [{ direct_answer_allowed: false, sources }] }).response_type, "KNOWLEDGE_MISSING");
});

test("loose keyword overlap does not answer unknown payload measurements", () => {
  for (const query of [
    "MELFI压力上限是多少", "水稻取样的刀口尺寸是多少", "蛋白质结晶的缓冲液配方是什么",
    "NASA设备编号是多少", "SREF微生物的灭活时间是多少", "人体实验心率100次可以继续吗",
  ]) assert.deepEqual(retriever.search(query), [], query);
  assert.deepEqual(retriever.search(""), []);
  assert.deepEqual(retriever.search(core[0].title, 0), []);
});

test("current instrument values and task-specific thresholds cannot be supplied from papers", async () => {
  const agent = new AgentOrchestrator();
  for (const [query, boundary, response] of [
    ["当前MELFI温度是多少", "NO_TELEMETRY", "KNOWLEDGE_NO_TELEMETRY"],
    ["本次水稻样品转移温度应该是多少", "TASK_SOP_REQUIRED", "KNOWLEDGE_SOP_REQUIRED"],
    ["怎样校准SREF中子探测器", "TASK_SOP_REQUIRED", "KNOWLEDGE_SOP_REQUIRED"],
    ["冷原子微波钟激光应该设置成多少", "TASK_SOP_REQUIRED", "KNOWLEDGE_SOP_REQUIRED"],
  ]) {
    assert.equal(knowledgeBoundary(query), boundary);
    const result = await agent.handleVoiceTurn({ session: agent.createSession(), recognized_text: query });
    assert.equal(result.response_type, response);
    assert.equal(result.knowledge.matched_records.length, 0);
  }
});

test("all 60 curated queries preserve an active multi-step task", async () => {
  const agent = new AgentOrchestrator();
  const selected = await agent.handleVoiceTurn({ session: agent.createSession(), recognized_text: "选择太空水稻在轨取样预处理实验" });
  const started = await agent.handleVoiceTurn({ session: selected.session, recognized_text: "开始流程" });
  const saved = JSON.parse(JSON.stringify(started.session));
  for (const record of core) for (const question of record.questions) {
    const result = await agent.handleVoiceTurn({ session: started.session, recognized_text: question.replace(/[？?]/gu, "") });
    assert.deepEqual(result.session, saved, question);
    assert.equal(result.knowledge.top_record_id, record.record_id, question);
    assert.equal(result.procedure.current_step, saved.current_step);
  }
});

test("equal scoped matches ask for clarification instead of silently choosing", () => {
  const agent = new AgentOrchestrator();
  const source = { title: "Fixture", url: "https://example.com/fixture" };
  const result = agent.composeKnowledgeResponse({ query: "重叠问题", results: [
    { score: 30, title: "主题甲", match_type: "SCOPED_KEYWORDS", direct_answer_allowed: true, sources: [source] },
    { score: 30, title: "主题乙", match_type: "SCOPED_KEYWORDS", direct_answer_allowed: true, sources: [source] },
  ] });
  assert.equal(result.response_type, "KNOWLEDGE_CLARIFICATION");
});

test("CSS report preserves species and SJ-10 remains a different experiment", () => {
  const sampling = core.find((item) => item.record_id === "qa02_css_rice_sampling");
  assert.match(sampling.content, /10月12日拟南芥开花期/u);
  assert.match(sampling.content, /9月21日水稻孕穗期/u);
  const sj10 = core.find((item) => item.record_id === "qa04_sj10_sampling");
  assert.match(sj10.content, /返回后在地面种植/u);
});

test("unlisted paraphrases match topic groups without using generic bigram overlap", () => {
  for (const [query, id] of [
    ["2022年中国空间站的水稻全生命周期培养，整个周期究竟有多久", "qa01_css_rice_duration"],
    ["NASA官方介绍里，MELFI有哪些设定点", "qa06_melfi_setpoints"],
    ["SREF里面的LET探测器负责什么测量", "qa16_sref_detectors"],
  ]) {
    const top = retriever.search(query)[0];
    assert.equal(top?.record_id, id);
    assert.equal(top.match_type, "SCOPED_KEYWORDS");
  }
});

test("question normalization preserves signed and decimal numeric meaning", () => {
  assert.notEqual(normalizeQuestion("负温度-80度？"), normalizeQuestion("负温度80度？"));
  assert.notEqual(normalizeQuestion("对照1.4g？"), normalizeQuestion("对照14g？"));
  assert.equal(normalizeQuestion("请问MELFI公开设定点？"), normalizeQuestion("MELFI公开设定点"));
});
