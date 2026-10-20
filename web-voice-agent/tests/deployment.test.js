const test = require("node:test");
const assert = require("node:assert/strict");
const { deploymentConfig, SessionStore, DemoAccess } = require("../server/deployment-security");
const { createApp } = require("../server/app-server");

const fixtureToken = "test-only-deployment-token-not-a-real-secret";
const asr = { getPublicConfig: () => ({ configured: false }), transcribe: async () => ({ ok: false, error: "ASR_UPSTREAM_FAILED", detail: { secret: fixtureToken } }) };
const tts = { getPublicConfig: () => ({ configured: false }), synthesize: async () => ({ ok: false, error: "TTS_UPSTREAM_FAILED", detail: fixtureToken }) };

async function fixture(config = deploymentConfig({}), extra = {}) {
  const app = createApp({ config, asrAdapters: asr, ttsAdapters: tts, ...extra });
  await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const origin = config.origin || base;
  const request = (route, body, cookie = "", overrides = {}) => fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Voice-Agent-Request": "1", Origin: origin }),
      ...(cookie ? { Cookie: cookie } : {}), ...overrides },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const grant = async (token = "") => {
    const response = await request("/api/access", { token });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  return { ...app, request, grant, close: () => new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }) };
}

test("production configuration fails closed without HTTPS and a strong access token", () => {
  assert.throws(() => deploymentConfig({ APP_ENV: "production" }), /HTTPS_ORIGIN/u);
  assert.throws(() => deploymentConfig({ APP_ENV: "production", PUBLIC_ORIGIN: "http://example.com" }), /HTTPS_ORIGIN/u);
  assert.throws(() => deploymentConfig({ APP_ENV: "production", PUBLIC_ORIGIN: "https://example.com" }), /ACCESS_TOKEN/u);
  assert.throws(() => deploymentConfig({ HOST: "0.0.0.0" }), /LOOPBACK/u);
  assert.throws(() => deploymentConfig({ PUBLIC_ORIGIN: "https://example.com/path" }), /ORIGIN_INVALID/u);
  assert.equal(deploymentConfig({}).host, "127.0.0.1");
});

test("server-held sessions enforce owner isolation, TTL, capacity and atomic turns", async () => {
  let now = 0;
  const store = new SessionStore({ now: () => now, ttl: 10, maxSessions: 1 });
  const session = store.create("owner1", { status: "IDLE" });
  assert.notEqual(session.session_id, "session_0");
  session.status = "FORGED";
  assert.equal(store.get(session.session_id, "owner1").session.status, "IDLE");
  assert.throws(() => store.get(session.session_id, "owner2"), /NOT_FOUND/u);
  assert.throws(() => store.create("owner2", {}), /CAPACITY/u);
  let finish;
  const first = store.turn(session.session_id, "owner1", (saved) => new Promise((resolve) => { finish = () => resolve({ session: saved }); }));
  await assert.rejects(store.turn(session.session_id, "owner1", async () => ({})), /BUSY/u);
  finish(); await first;
  await assert.rejects(store.turn(session.session_id, "owner1", async (saved) => { saved.status = "MUTATED"; throw new Error("fixture"); }), /fixture/u);
  assert.equal(store.get(session.session_id, "owner1").session.status, "IDLE");
  now = 11;
  assert.throws(() => store.get(session.session_id, "owner1"), /EXPIRED/u);
  assert.ok(store.create("owner2", {}).session_id);
});

test("access, CSRF checks, static allowlist and actual capability counts", async () => {
  const app = await fixture();
  try {
    assert.equal((await app.request("/api/health")).status, 200);
    assert.equal((await app.request("/api/capabilities")).status, 401);
    assert.equal((await app.request("/api/access", {}, "", { Origin: "https://foreign.example" })).status, 403);
    assert.equal((await app.request("/api/access", {}, "", { "X-Voice-Agent-Request": "" })).status, 403);
    const cookie = await app.grant();
    const response = await app.request("/api/capabilities", undefined, cookie);
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/u);
    assert.match(response.headers.get("permissions-policy"), /camera=\(\)/u);
    const caps = await response.json();
    assert.equal(caps.experiment_count, 20); assert.equal(caps.demo_procedure_count, 1);
    assert.equal(caps.approved_procedure_count, 0); assert.equal(caps.public_source_count, 48);
    assert.equal(caps.review_draft_count, 4); assert.equal(caps.review_draft_step_count, 32);
    assert.equal(caps.review_draft_exception_count, 20);
    assert.equal(caps.expanded_question_count, 16); assert.equal(caps.curated_question_count, 52);
    assert.equal(caps.rice_update_question_count, 16);
    assert.equal(caps.core_question_count, 20); assert.equal(caps.flight_ready, false);
    assert.equal(caps.detailed_demo_step_count, 9); assert.equal(caps.knowledge_understanding.configured, false);
    assert.equal(caps.knowledge_understanding.live_verified, false); assert.equal(caps.exception_categories.length, 7);
    const procedures = await (await app.request("/api/procedures", undefined, cookie)).json();
    assert.equal(procedures.guidance_ready, false); assert.equal(procedures.demo_guidance_ready, true);
    assert.equal(procedures.procedures[0].steps.length, 9);
    assert.equal(procedures.review_drafts.length, 4);
    assert(procedures.review_drafts.every(d => d.flight_execution_allowed === false && d.guidance_available === false));
    const html = await (await app.request("/")).text();
    assert.doesNotMatch(html, /<textarea|<input|contenteditable|onclick=/iu);
    assert.equal((await app.request("/.env")).status, 404);
    assert.equal((await app.request("/server/index.js")).status, 404);
    assert.equal((await app.request("/knowledge_base/project-question-candidates.json")).status, 404);
  } finally { await app.close(); }
});

test("forged browser state cannot skip steps or access another browser's session", async () => {
  const app = await fixture();
  try {
    const owner1 = await app.grant(); const owner2 = await app.grant();
    const session = await (await app.request("/api/session", {}, owner1)).json();
    const voice = (text, extra = {}, cookie = owner1) => app.request("/api/voice/turn", { session_id: session.session_id, recognized_text: text, ...extra }, cookie);
    await voice("选择太空水稻实验"); await voice("开始流程");
    const forged = await (await voice("下一步", { session: { ...session, status: "COMPLETED", current_step: "sample_storage", completed_steps: ["fake"], observations: { cultivation_days: 120 } } })).json();
    assert.equal(forged.response_type, "STEP_WAITING_INPUT");
    assert.equal(forged.session.current_step, "cultivation_state_check");
    assert.equal(forged.session.completed_steps.length, 0);
    assert.equal((await voice("当前状态", {}, owner2)).status, 404);
    const restored = await (await app.request("/api/session", {}, owner1)).json();
    assert.equal(restored.session_id, session.session_id); assert.equal(restored.current_step, "cultivation_state_check");
  } finally { await app.close(); }
});

test("restricted production handshake uses HttpOnly Secure cookie without disclosing token", async () => {
  const app = await fixture(deploymentConfig({ APP_ENV: "production", PUBLIC_ORIGIN: "https://demo.example", DEPLOY_ACCESS_TOKEN: fixtureToken }));
  try {
    assert.equal((await app.request("/api/access", { token: "wrong" })).status, 401);
    const response = await app.request("/api/access", { token: fixtureToken });
    assert.equal(response.status, 200);
    const cookieHeader = response.headers.get("set-cookie");
    assert.match(cookieHeader, /HttpOnly; SameSite=Strict/u); assert.match(cookieHeader, /; Secure/u);
    assert.ok(!cookieHeader.includes(fixtureToken)); assert.ok(!(await response.text()).includes(fixtureToken));
    const cookie = cookieHeader.split(";")[0];
    assert.equal((await app.request("/api/session", {}, cookie, { Origin: "http://demo.example" })).status, 403);
    assert.equal((await app.request("/api/session", {}, cookie)).status, 200);
  } finally { await app.close(); }
});

test("bad JSON, oversized bodies and malformed turns return bounded errors", async () => {
  const app = await fixture();
  try {
    const cookie = await app.grant();
    assert.equal((await app.request("/api/session", "x".repeat(3000), cookie)).status, 413);
    assert.equal((await app.request("/api/session", {}, cookie, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await app.request("/api/voice/turn", { session_id: "forged", recognized_text: "" }, cookie)).status, 400);
    assert.equal((await app.request("/api/tts/synthesize", { text: { bad: true } }, cookie)).status, 400);
  } finally { await app.close(); }
});

test("upstream diagnostic objects never leak to API callers", async () => {
  const app = await fixture();
  try {
    const cookie = await app.grant();
    const result = await app.request("/api/tts/synthesize", { text: "测试播报" }, cookie);
    const text = await result.text();
    assert.equal(result.status, 503); assert.ok(!text.includes(fixtureToken)); assert.ok(!text.includes("detail"));
  } finally { await app.close(); }
});

test("owner request rate limit returns retry-after instead of unbounded work", async () => {
  const config = deploymentConfig({});
  const app = await fixture(config, { access: new DemoAccess(config, { requestLimit: 2 }) });
  try {
    const cookie = await app.grant();
    await app.request("/api/capabilities", undefined, cookie); await app.request("/api/capabilities", undefined, cookie);
    const limited = await app.request("/api/capabilities", undefined, cookie);
    assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "60");
  } finally { await app.close(); }
});

test("speech concurrency is bounded before collecting an audio body", async () => {
  const pending = []; let allStarted;
  const started = new Promise((resolve) => { allStarted = resolve; });
  const adapter = { ...asr, transcribe: () => new Promise((resolve) => {
    pending.push(resolve); if (pending.length === 4) allStarted();
  }) };
  const app = await fixture(deploymentConfig({}), { asrAdapters: adapter });
  let requests = [];
  try {
    const cookie = await app.grant();
    requests = Array.from({ length: 4 }, () => app.request("/api/asr/transcribe", "test-only-audio", cookie));
    await started;
    const fifth = await app.request("/api/asr/transcribe", "test-only-audio", cookie);
    assert.equal(fifth.status, 503); assert.equal((await fifth.json()).error, "SPEECH_CAPACITY_REACHED");
    for (const resolve of pending) resolve({ ok: true, text: "模拟识别" });
    assert.ok((await Promise.all(requests)).every((response) => response.status === 200));
  } finally {
    for (const resolve of pending) resolve({ ok: false, error: "FIXTURE_END" });
    await Promise.allSettled(requests); await app.close();
  }
});
