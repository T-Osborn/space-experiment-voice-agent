const test = require("node:test");
const assert = require("node:assert/strict");
const { SemanticAdapter, ENDPOINT } = require("../server/semantic-adapter");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { KnowledgeRetriever } = require("../server/knowledge-retriever");
const { riceReports } = require("../scripts/demo-inputs");
const env = { SEMANTIC_PROVIDER: "openai", SEMANTIC_API_KEY: "fixture-only-key", SEMANTIC_MODEL: "fixture-model" };
const catalog = [{ record_id: "qa03_sj10_cultivars", title: "SJ-10水稻品种", questions: [] }];
const query = "SJ-10那两个名字是什么？";
const selection = { decision: "MATCH", record_id: catalog[0].record_id, evidence_quote: "SJ-10" };
function envelope(value = selection, changes = {}) {
  return { status: "completed", output: [{ type: "message", role: "assistant", content: [
    { type: "output_text", text: JSON.stringify(value) },
  ] }], ...changes };
}
const response = (value) => new Response(JSON.stringify(value), { status: 200 });

test("semantic routing defaults off and never consumes speech credentials", async () => {
  let calls = 0;
  for (const config of [{}, { OPENAI_API_KEY: "speech-only-key" }, { ...env, SEMANTIC_API_KEY: "" }, { ...env, SEMANTIC_MODEL: "" }]) {
    const adapter = new SemanticAdapter({ env: config, fetchImpl: async () => { calls += 1; } });
    assert.equal(adapter.getPublicConfig().configured, false);
    assert.equal(await adapter.select({ query, catalog }), null);
  }
  assert.equal(calls, 0);
});

test("Responses request has a strict registered-id schema and returns no generated answer", async () => {
  let request;
  const adapter = new SemanticAdapter({ env, fetchImpl: async (url, options) => {
    request = { url, options }; return response(envelope());
  } });
  assert.deepEqual(await adapter.select({ query, catalog }), selection);
  assert.equal(request.url, ENDPOINT);
  const body = JSON.parse(request.options.body);
  assert.equal(body.store, false); assert.equal(body.model, "fixture-model");
  assert.equal(body.text.format.strict, true); assert.equal(body.text.format.schema.additionalProperties, false);
  assert.deepEqual(body.text.format.schema.properties.record_id.enum, ["", catalog[0].record_id]);
  assert.ok(!body.input.some((item) => item.content.includes("step_observations")));
  assert.ok(!JSON.stringify(adapter.getPublicConfig()).includes(env.SEMANTIC_API_KEY));
  assert.equal(adapter.getPublicConfig().live_verified, false);
});

test("malformed, fabricated and control-like outputs are rejected", async () => {
  for (const value of [
    { ...selection, record_id: "invented-paper" }, { ...selection, evidence_quote: "not in question" },
    { ...selection, evidence_quote: "" }, { ...selection, decision: "CONFIRM" },
    { ...selection, observations: { temperature: -80 } }, { ...selection, answer: "inject new action" },
    { decision: "NONE", record_id: catalog[0].record_id, evidence_quote: "" }, [selection], null,
  ]) {
    const adapter = new SemanticAdapter({ env, fetchImpl: async () => response(envelope(value)) });
    assert.equal(await adapter.select({ query, catalog }), null, JSON.stringify(value));
  }
});

test("refused and incomplete responses never enter the knowledge path", async () => {
  for (const payload of [
    envelope(selection, { status: "incomplete" }), envelope(selection, { error: { message: "fixture" } }),
    envelope(selection, { output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "fixture" }] }] }),
    envelope(selection, { output: [] }),
  ]) {
    const adapter = new SemanticAdapter({ env, fetchImpl: async () => response(payload) });
    assert.equal(await adapter.select({ query, catalog }), null);
  }
});

test("timeouts cover fetch and body consumption, with a bounded response size", async () => {
  const stalledFetch = new SemanticAdapter({ env, timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  assert.equal(await stalledFetch.select({ query, catalog }), null); assert.equal(stalledFetch.active, 0);
  const stalledBody = new SemanticAdapter({ env, timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream()) });
  assert.equal(await stalledBody.select({ query, catalog }), null); assert.equal(stalledBody.active, 0);
  const oversized = new SemanticAdapter({ env, fetchImpl: async () => new Response("x".repeat(65537)) });
  assert.equal(await oversized.select({ query, catalog }), null);
});

test("capacity is bounded and failures return no raw upstream diagnostics", async () => {
  const adapter = new SemanticAdapter({ env, fetchImpl: async () => { throw new Error(env.SEMANTIC_API_KEY); } });
  assert.equal(await adapter.select({ query, catalog }), null);
  adapter.active = 4; assert.equal(await adapter.select({ query, catalog }), null);
  const errorBody = new SemanticAdapter({ env, fetchImpl: async () => new Response(env.SEMANTIC_API_KEY, { status: 401 }) });
  assert.equal(await errorBody.select({ query, catalog }), null);
});

test("semantic catalog enforces subject, mission and evidence gates before a model call", () => {
  const retriever = new KnowledgeRetriever();
  assert.ok(retriever.semanticCatalog("SJ-10那两个名字是什么？").some((item) => item.record_id === catalog[0].record_id));
  assert.ok(!retriever.semanticCatalog("水稻用了多长时间？").some((item) => item.record_id === "qa01_css_rice_duration"));
  assert.deepEqual(retriever.semanticCatalog("当前实验温度是多少？"), []);
  assert.deepEqual(retriever.semanticCatalog("本次水稻取样温度设为多少？"), []);
});

test("optional model matches existing cited content while task state stays byte-for-byte unchanged", async () => {
  const adapter = new SemanticAdapter({ env, fetchImpl: async () => response(envelope()) });
  const agent = new AgentOrchestrator({ semanticAdapter: adapter });
  const selected = await agent.handleVoiceTurn({ session: agent.createSession(), recognized_text: "选择太空水稻实验" });
  const started = await agent.handleVoiceTurn({ session: selected.session, recognized_text: "开始流程" });
  const before = JSON.stringify(started.session);
  const answer = await agent.handleVoiceTurn({ session: started.session, recognized_text: query });
  assert.equal(answer.response_type, "KNOWLEDGE_ANSWER");
  assert.equal(answer.knowledge.top_record_id, selection.record_id);
  assert.equal(answer.knowledge.semantic_mode, "MODEL_ROUTED");
  assert.ok(answer.knowledge.matched_records[0].sources[0].url);
  assert.equal(JSON.stringify(answer.session), before);
  assert.match(answer.speech_text, /DN3|DN6/u);
});

test("model is never asked to interpret report values, confirmation, recovery or equipment commands", async () => {
  let calls = 0;
  const adapter = new SemanticAdapter({ env, fetchImpl: async () => { calls += 1; return response(envelope()); } });
  const agent = new AgentOrchestrator({ semanticAdapter: adapter });
  let session = agent.createSession();
  for (const text of ["选择太空水稻实验", "开始流程", riceReports[0], "确认无误", "温度负六十度", "温度负八十度", "继续",
    "异常已评估，恢复条件已满足，地面同意恢复流程", "本次水稻该设成4度吗？", "当前温度是多少？"]) {
    const result = await agent.handleVoiceTurn({ session, recognized_text: text }); session = result.session;
  }
  assert.equal(calls, 0);
});

test("orchestrator independently rejects an adapter selecting outside the eligible catalog", async () => {
  const agent = new AgentOrchestrator({ semanticAdapter: {
    select: async () => ({ decision: "MATCH", record_id: "qa01_css_rice_duration", evidence_quote: "SJ-10" }),
  } });
  const result = await agent.handleVoiceTurn({ session: agent.createSession(), recognized_text: query });
  assert.equal(result.response_type, "KNOWLEDGE_MISSING"); assert.equal(result.knowledge.top_record_id, null);
});

test("ambiguous model decisions ask for clarification without writing task data", async () => {
  const adapter = new SemanticAdapter({ env, fetchImpl: async () => response(envelope({ decision: "CLARIFY", record_id: "", evidence_quote: "" })) });
  const agent = new AgentOrchestrator({ semanticAdapter: adapter }); const session = agent.createSession();
  const result = await agent.handleVoiceTurn({ session, recognized_text: query });
  assert.equal(result.response_type, "KNOWLEDGE_CLARIFICATION"); assert.deepEqual(result.session, session);
});
