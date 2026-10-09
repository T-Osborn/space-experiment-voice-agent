const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { discoverBaiduVoices, LIST_URL } = require("../scripts/inspect-baidu-voices");

const credentials = { BAIDU_API_KEY: "fake-discovery-ak", BAIDU_SECRET_KEY: "fake-discovery-sk" };
const token = "fake-discovery-token";
const voice = (id, name = "实验助手") => ({ voice_id: id, voice_name: name, lang: "zh", status: 0, voice_desc: credentials.BAIDU_SECRET_KEY });
const list = (items, total = items.length, page = 1, pageSize = 2) => ({ status: 0, data: { items, total, page, page_size: pageSize } });

function fixture(handler = () => list([voice(100001)]), overrides = {}) {
  const calls = [];
  return {
    calls,
    run: (options = {}) => discoverBaiduVoices({
      env: () => ({ ...credentials, ...overrides }),
      now: () => new Date("2026-10-07T00:00:00Z"),
      request: async (url, requestOptions, timeout, consume) => {
        const parsedUrl = new URL(url);
        calls.push({ url: parsedUrl, options: requestOptions, timeout });
        const payload = parsedUrl.pathname.endsWith("/token") ? { access_token: token, expires_in: 3600 } : await handler(JSON.parse(requestOptions.body), calls);
        return consume(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
      },
      ...options,
    }),
  };
}

test("discovery uses only official authentication and read-only clone/list, with no automatic selection", async () => {
  const { run, calls } = fixture();
  const result = await run();
  assert.equal(result.authenticated, true);
  assert.equal(result.clone_list.status, "complete");
  assert.deepEqual(result.clone_list.voices, [{ voice_id: 100001, voice_name: "实验助手", lang: "zh" }]);
  assert.equal(result.selected_voice, null);
  assert.equal(result.selection_required, true);
  assert.equal(result.real_asr_verified, false);
  assert.equal(result.real_tts_verified, false);
  assert.equal(result.ordinary_voice_selection, "not_discoverable_from_credentials");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.origin, "https://aip.baidubce.com");
  assert.equal(calls[0].url.pathname, "/oauth/2.0/token");
  assert.equal(calls[1].url.origin + calls[1].url.pathname, LIST_URL);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.redirect, "error");
  assert.deepEqual(JSON.parse(calls[1].options.body), { page: 1 });
});

test("missing keys cause no requests or claims about available voices", async () => {
  const { run, calls } = fixture(undefined, { BAIDU_API_KEY: "", BAIDU_SECRET_KEY: "" });
  const result = await run();
  assert.equal(result.auth_error, "BAIDU_NOT_CONFIGURED");
  assert.equal(result.clone_list.status, "not_checked");
  assert.equal(calls.length, 0);
});

test("invalid authentication and unreachable networks return only safe codes", async () => {
  for (const request of [
    async (url, options, timeout, consume) => consume(new Response(JSON.stringify({ error: "invalid_client", error_description: credentials.BAIDU_SECRET_KEY }))),
    async () => { throw new Error(`network ${credentials.BAIDU_API_KEY} ${credentials.BAIDU_SECRET_KEY}`); },
  ]) {
    const { run } = fixture();
    const result = await run({ request });
    assert.equal(result.authenticated, false);
    assert.equal(result.clone_list.status, "not_checked");
    assert.ok(["BAIDU_AUTH_FAILED", "BAIDU_AUTH_UNREACHABLE"].includes(result.auth_error));
    for (const secret of Object.values(credentials)) assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("successful empty list does not infer ordinary voice or service readiness", async () => {
  const result = await fixture(() => list([], 0)).run();
  assert.equal(result.clone_list.status, "complete");
  assert.equal(result.clone_list.total, 0);
  assert.equal(result.selected_voice, null);
  assert.equal(result.real_tts_verified, false);
});

test("rejected voice listing is distinct from an empty successful list", async () => {
  const result = await fixture(() => ({ status: 1, message: `${token} ${credentials.BAIDU_SECRET_KEY}` })).run();
  assert.equal(result.authenticated, true);
  assert.equal(result.clone_list.status, "failed");
  assert.equal(result.clone_list.total, null);
  assert.equal(result.clone_list.error, "BAIDU_VOICE_LIST_REJECTED");
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("multiple pages are fetched without selecting the first voice", async () => {
  const result = await fixture(({ page }) => page === 1 ? list([voice(1), voice(2)], 3) : list([voice(3)], 3, 2)).run();
  assert.equal(result.clone_list.status, "complete");
  assert.equal(result.clone_list.pages_read, 2);
  assert.equal(result.clone_list.voices.length, 3);
  assert.equal(result.selected_voice, null);
});

test("request and item limits explicitly mark partial results", async () => {
  for (const options of [{ maxPages: 1 }, { maxVoices: 1 }]) {
    const { run, calls } = fixture(() => list([voice(1), voice(2)], 3));
    const result = await run(options);
    assert.equal(result.clone_list.status, "partial");
    assert.equal(result.clone_list.error, "QUERY_LIMIT_REACHED");
    assert.equal(calls.length, 2);
    assert.ok(result.clone_list.voices.length <= (options.maxVoices || 500));
  }
});

test("a later page failure preserves only validated partial metadata", async () => {
  const result = await fixture(({ page }) => {
    if (page > 1) throw new Error(`failure ${token}`);
    return list([voice(1), voice(2)], 3);
  }).run();
  assert.equal(result.clone_list.status, "partial");
  assert.equal(result.clone_list.pages_read, 1);
  assert.equal(result.clone_list.error, "BAIDU_VOICE_LIST_UNREACHABLE");
  assert.equal(result.clone_list.voices.length, 2);
});

test("invalid pages, IDs and duplicates are never presented as complete", async () => {
  for (const payload of [list([voice(1), voice(1)]), list([voice(-1)]), list([voice(1)], 0), list([], 3), list([voice(1)], 1, 2), { status: 0, data: { total: 1, items: [voice(1)] } }]) {
    const result = await fixture(() => payload).run();
    assert.equal(result.clone_list.status, "failed");
    assert.equal(result.clone_list.error, "BAIDU_VOICE_LIST_INVALID");
    assert.equal(result.clone_list.voices.length, 0);
  }
});

test("result uses an allowlist and redacts echoed secrets, links and console controls", async () => {
  const result = await fixture(() => list([voice(1, `${credentials.BAIDU_API_KEY} ${credentials.BAIDU_SECRET_KEY} ${token}\u001b[2J https://example.test/?token=secret`)] )).run();
  const output = JSON.stringify(result);
  for (const secret of [...Object.values(credentials), token]) assert.equal(output.includes(secret), false);
  assert.equal(output.includes("example.test"), false);
  assert.equal(output.includes("voice_desc"), false);
  assert.equal(output.includes("\\u001b"), false);
});

test("private wrapper hides both credentials, never embeds them in arguments, and does not load .env", () => {
  const wrapper = fs.readFileSync(path.join(__dirname, "../check-baidu-voices.ps1"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../scripts/inspect-baidu-voices.js"), "utf8");
  assert.equal((wrapper.match(/Read-Host[^\r\n]+-AsSecureString/gu) || []).length, 2);
  assert.match(wrapper, /\$queryInfo\.Arguments = '"' \+ \$probePath \+ '"'/u);
  assert.doesNotMatch(wrapper, /SetEnvironmentVariable|Set-Content|Out-File|Start-Transcript/u);
  assert.doesNotMatch(script, /loadEnvFile|\.env"/u);
  assert.match(wrapper, /ZeroFreeBSTR\(\$keyPointer\)/u);
  assert.match(wrapper, /ZeroFreeBSTR\(\$secretPointer\)/u);
});
