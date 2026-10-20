const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/app-server');
const { createFrontendServer, localServiceUrl } = require('../server/frontend-server');
const { createAdminServer } = require('../server/admin-server');
const { AdminService } = require('../server/admin-service');

const fixturePrivate = 'fixture-private-do-not-return-to-console';
const asr = { getPublicConfig: () => ({ upstream_provider: 'baidu', configured: true, key: fixturePrivate }),
  transcribe: async ({ audioBuffer }) => ({ ok: true, text: '模拟识别' + audioBuffer.length }) };
const tts = { getPublicConfig: () => ({ upstream_provider: 'baidu', configured: true, target_voice: '测试音色 per 5', voice_id: 5, service: 'short_text', secret_key: fixturePrivate }),
  synthesize: async () => ({ ok: true, contentType: 'audio/mpeg', buffer: Buffer.from('test-only-audio') }) };
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function fixture() {
  const backend = createApp({ serveFrontend: false, asrAdapters: asr, ttsAdapters: tts });
  const apiUrl = await listen(backend.server);
  const frontend = createFrontendServer({ backendUrl: apiUrl });
  const demoUrl = await listen(frontend.server);
  const service = new AdminService({ backendUrl: apiUrl, demoUrl });
  const admin = createAdminServer({ service });
  const adminUrl = await listen(admin.server);
  return { backend, frontend, admin, service, apiUrl, demoUrl, adminUrl,
    close: async () => { await close(admin.server); await close(frontend.server); await close(backend.server); } };
}
function post(base, route, value, cookie = '', extraHeaders = {}) {
  return fetch(base + route, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Voice-Agent-Request': '1', Origin: base,
    ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders,
  }, body: JSON.stringify(value) });
}
async function grant(base, management = false) {
  const response = await post(base, management ? '/api/admin/access' : '/api/access', {});
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('separated frontend serves the original voice workspace while API-only and admin remain distinct', async () => {
  const f = await fixture();
  try {
    const page = await (await fetch(f.demoUrl)).text();
    assert.match(page, /实验任务工作台/u);
    assert.doesNotMatch(page, /<textarea|<input|Agent 管理控制台/u);
    const adminPage = await (await fetch(f.adminUrl)).text();
    assert.match(adminPage, /Agent 管理控制台/u);
    assert.match(adminPage, /知识库搭建|音色配置/u);
    assert.equal((await fetch(f.apiUrl)).status, 404);
    assert.equal((await fetch(f.apiUrl + '/api/health')).status, 200);
    for (const url of [f.demoUrl + '/admin.css', f.demoUrl + '/api/admin/overview', f.adminUrl + '/app.js', f.adminUrl + '/server/admin-service.js']) {
      assert.equal((await fetch(url)).status, 404, url);
    }
    const apiCookie = await grant(f.apiUrl);
    assert.equal((await fetch(f.apiUrl + '/api/admin/overview', { headers: { Cookie: apiCookie } })).status, 404);
  } finally { await f.close(); }
});

test('frontend proxy preserves access cookies, CSRF protection, task state and audio bytes', async () => {
  const f = await fixture();
  try {
    const cookie = await grant(f.demoUrl);
    const sessionReply = await post(f.demoUrl, '/api/session', {}, cookie);
    const session = await sessionReply.json();
    assert.ok(session.session_id);
    const voice = async text => {
      const reply = await post(f.demoUrl, '/api/voice/turn', { session_id: session.session_id, recognized_text: text }, cookie);
      assert.equal(reply.status, 200); return reply.json();
    };
    assert.equal((await voice('选择太空水稻实验')).response_type, 'EXPERIMENT_SELECTED');
    assert.equal((await voice('开始流程')).session.current_step, 'cultivation_state_check');
    const partial = await voice('培养周期九十五天');
    assert.equal(partial.session.step_observations.cultivation_days, 95);
    const raw = await (await post(f.apiUrl, '/api/session', {}, cookie)).json();
    assert.equal(raw.session_id, session.session_id);
    assert.equal(raw.step_observations.cultivation_days, 95);
    assert.equal((await post(f.demoUrl, '/api/session', {}, cookie, { Origin: 'https://foreign.example' })).status, 403);
    const recognized = await fetch(f.demoUrl + '/api/asr/transcribe', { method: 'POST', headers: { Cookie: cookie,
      'X-Voice-Agent-Request': '1', Origin: f.demoUrl, 'Content-Type': 'audio/pcm' }, body: Buffer.from([1, 2, 3]) });
    assert.equal((await recognized.json()).text, '模拟识别3');
    const speech = await post(f.demoUrl, '/api/tts/synthesize', { text: '测试' }, cookie);
    assert.equal(speech.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await speech.text(), 'test-only-audio');
  } finally { await f.close(); }
});

test('management uses its own cookie and cannot accept a demo owner or mutate configuration', async () => {
  const f = await fixture();
  try {
    const demoCookie = await grant(f.demoUrl);
    const overview = f.adminUrl + '/api/admin/overview';
    assert.equal((await fetch(overview)).status, 401);
    assert.equal((await fetch(overview, { headers: { Cookie: demoCookie } })).status, 401);
    const adminCookie = await grant(f.adminUrl, true);
    assert.match(adminCookie, /^va_admin=/u);
    assert.doesNotMatch(adminCookie, /^va_owner=/u);
    assert.equal((await post(f.adminUrl, '/api/admin/access', {}, '', { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post(f.adminUrl, '/api/admin/modules/voice', { voice_id: 0 }, adminCookie)).status, 405);
    const detail = await (await fetch(f.adminUrl + '/api/admin/modules/voice', { headers: { Cookie: adminCookie } })).json();
    assert.equal(detail.editable, false);
    assert.ok(detail.documents.length);
    assert.equal((await post(f.adminUrl, '/api/voice/turn', { recognized_text: '确认无误' }, adminCookie)).status, 404);
  } finally { await f.close(); }
});

test('management reports actual module counts, sanitized runtime state and reuses its non-task visitor', async () => {
  const f = await fixture();
  try {
    const first = await f.service.overview();
    assert.equal(first.modules.length, 5);
    assert.equal(first.knowledge.question_count, 52);
    assert.equal(first.knowledge.public_source_count, 48);
    assert.equal(first.experiments.count, 20);
    assert.equal(first.experiments.demo_count, 1);
    assert.equal(first.experiments.approved_count, 0);
    assert.equal(first.runtime.tts.voice_id, 5);
    assert.equal(first.runtime.asr.configured, true);
    assert.equal(first.runtime.general_llm_connected, false);
    assert.equal(first.read_only, true);
    assert.ok(first.modules.every(m => m.files.every(file => file.available)));
    assert.ok(!JSON.stringify(first).includes(fixturePrivate));
    await f.service.overview(); await f.service.overview();
    assert.equal(f.backend.access.owners.size, 1);
    assert.equal(f.backend.sessions.sessions.size, 0);
  } finally { await f.close(); }
});

test('module document lookup is bounded and never exposes secret files, code or personal records', async () => {
  const f = await fixture();
  try {
    const cookie = await grant(f.adminUrl, true);
    for (const route of ['/api/admin/modules/env', '/api/admin/modules/records', '/.env', '/data/records.sqlite', '/api/admin/modules/../voice.json']) {
      assert.equal((await fetch(f.adminUrl + route, { headers: { Cookie: cookie } })).status, 404, route);
    }
    for (const id of ['ui', 'knowledge', 'skills', 'prompts', 'voice']) {
      const detail = f.service.detail(id);
      assert.equal(detail.id, id);
      assert.ok(detail.files.every(file => !/(?:\.env|\/data\/|private|backups)/u.test(file.path)));
      assert.ok(detail.documents.every(doc => /\.(?:md|json)$/u.test(doc.path)));
    }
  } finally { await f.close(); }
});

test('unavailable backend leaves both frontends usable and reports an honest disconnected state', async () => {
  const backendUrl = 'http://127.0.0.1:1/';
  const { server } = createFrontendServer({ backendUrl });
  const base = await listen(server);
  try {
    assert.equal((await fetch(base)).status, 200);
    const failed = await fetch(base + '/api/health');
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error, 'AGENT_BACKEND_UNAVAILABLE');
    const status = await new AdminService({ backendUrl }).overview();
    assert.equal(status.runtime.reachable, false);
    assert.equal(status.knowledge.question_count, 52);
    assert.equal(status.runtime.asr, undefined);
  } finally { await close(server); }
});

test('only local trusted backend addresses are accepted and the proxy strips admin cookies', async () => {
  for (const url of ['https://example.com', 'http://example.com', 'http://127.0.0.1/config', 'http://user:pass@127.0.0.1/', 'http://127.0.0.1/?url=https://example.com']) {
    assert.throws(() => localServiceUrl(url), /LOCAL_AGENT_URL_INVALID/u);
  }
  const inspector = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ cookie: req.headers.cookie })); });
  const inspectorUrl = await listen(inspector);
  const frontend = createFrontendServer({ backendUrl: inspectorUrl });
  const base = await listen(frontend.server);
  try {
    const data = await (await fetch(base + '/api/inspect', { headers: { Cookie: 'va_owner=demo; va_admin=private-admin' } })).json();
    assert.equal(data.cookie, 'va_owner=demo');
  } finally { await close(frontend.server); await close(inspector); }
});
