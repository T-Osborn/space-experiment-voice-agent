const test = require("node:test");
const assert = require("node:assert/strict");
const { BaiduSpeechClient } = require("../server/baidu-speech");
const { ASRAdapterRegistry } = require("../server/asr-adapters");
const { TTSAdapterRegistry } = require("../server/tts-adapters");
const { fetchWithTimeout } = require("../server/http-utils");

const credentials = { BAIDU_API_KEY: "fake-project-ak", BAIDU_SECRET_KEY: "fake-project-sk" };
const pcm = Buffer.from([0, 0, 255, 127, 0, 128, 0, 0]);
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
const audio = () => new Response(Buffer.from("ID3-mock-audio-not-a-playback-test"), { headers: { "Content-Type": "audio/mp3" } });

function makeClient(overrides = {}, handler = null) {
  const env = { ...credentials, ...overrides };
  const calls = [];
  let clock = 1000;
  const client = new BaiduSpeechClient({
    env: () => env, now: () => clock,
    request: async (url, options, timeout, consume) => {
      const call = { url: new URL(url), options, timeout };
      calls.push(call);
      const response = handler ? await handler(call) : call.url.pathname.endsWith("/token")
        ? json({ access_token: "fake-access-token", expires_in: 3600 })
        : call.url.pathname.endsWith("/server_api") ? json({ err_no: 0, result: ["温度负八十度"] }) : audio();
      return consume(response);
    },
  });
  return { client, calls, env, setClock: (value) => { clock = value; } };
}

test("Baidu ASR authenticates and sends correctly labelled PCM bytes", async () => {
  const { client, calls } = makeClient();
  const result = await client.transcribe({ audioBuffer: pcm, contentType: "audio/pcm;rate=16000" });
  assert.deepEqual(result, { ok: true, text: "温度负八十度" });
  assert.equal(calls[0].url.protocol, "https:");
  assert.equal(calls[0].url.searchParams.get("grant_type"), "client_credentials");
  assert.equal(calls[0].url.searchParams.get("client_id"), credentials.BAIDU_API_KEY);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.format, "pcm");
  assert.equal(body.channel, 1);
  assert.equal(body.rate, 16000);
  assert.equal(body.dev_pid, 1537);
  assert.equal(body.len, pcm.length);
  assert.deepEqual(Buffer.from(body.speech, "base64"), pcm);
  assert.equal(body.token, "fake-access-token");
  assert.equal(calls[1].options.redirect, "error");
});

test("unsupported, odd-length or overlong recording is rejected before any request", async () => {
  const { client, calls } = makeClient();
  for (const [buffer, contentType, expected] of [
    [pcm, "audio/webm", "ASR_AUDIO_FORMAT_INVALID"],
    [Buffer.alloc(3), "audio/pcm;rate=16000", "ASR_AUDIO_INVALID"],
    [Buffer.alloc(1920002), "audio/pcm;rate=16000", "ASR_AUDIO_TOO_LONG"],
  ]) assert.equal((await client.transcribe({ audioBuffer: buffer, contentType })).error, expected);
  assert.equal(calls.length, 0);
});

test("ASR and TTS share a cached token, with expiry causing renewal", async () => {
  const { client, calls, setClock } = makeClient();
  await client.transcribe({ audioBuffer: pcm, contentType: "audio/pcm;rate=16000" });
  await client.synthesize("请确认当前步骤。");
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/token")).length, 1);
  setClock(3600001);
  await client.synthesize("读回数据。");
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/token")).length, 2);
});

test("simultaneous requests obtain only one token and changing credentials renews it", async () => {
  const { client, calls, env } = makeClient();
  await Promise.all([client.getToken(), client.getToken(), client.getToken()]);
  assert.equal(calls.length, 1);
  env.BAIDU_SECRET_KEY = "another-fake-sk";
  await client.getToken();
  assert.equal(calls.length, 2);
});

test("standard TTS uses configured voice, double-encoded text and MP3", async () => {
  const { client, calls } = makeClient({ BAIDU_TTS_VOICE: "106", BAIDU_TTS_SPEED: "4" });
  const text = "A+B & 水稻，请确认。";
  const result = await client.synthesize(text);
  assert.equal(result.ok, true);
  assert.equal(result.contentType, "audio/mpeg");
  const form = new URLSearchParams(calls[1].options.body);
  assert.equal(form.get("tex"), encodeURIComponent(text));
  assert.equal(decodeURIComponent(form.get("tex")), text);
  assert.equal(form.get("per"), "106");
  assert.equal(form.get("spd"), "4");
  assert.equal(form.get("aue"), "3");
  assert.equal(form.get("tok"), "fake-access-token");
});

test("clone TTS sends a voice_id to the distinct documented clone endpoint", async () => {
  const { client, calls } = makeClient({ BAIDU_TTS_SERVICE: "clone", BAIDU_TTS_VOICE: "100001" });
  const result = await client.synthesize("请报告实验状态。");
  assert.equal(result.ok, true);
  assert.match(calls[1].url.pathname, /\/voice\/clone\/tts$/u);
  assert.equal(calls[1].url.searchParams.get("access_token"), "fake-access-token");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.voice_id, 100001);
  assert.equal(body.media_type, "mp3");
  assert.equal(body.text, "请报告实验状态。");
});

test("2.0 defaults to short-text per=5 while an explicit zero remains selectable", async () => {
  for (const [overrides, expectedVoice] of [[{}, "5"], [{ BAIDU_TTS_VOICE: "0" }, "0"]]) {
    const { client, calls } = makeClient(overrides);
    assert.equal(client.getTtsConfig().voiceId, Number(expectedVoice));
    assert.equal((await client.synthesize("请报告实验状态。")).ok, true);
    assert.equal(calls[1].url.href, "https://tsn.baidu.com/text2audio");
    assert.equal(new URLSearchParams(calls[1].options.body).get("per"), expectedVoice);
  }
});

test("clone without a positive voice_id cannot be mistaken for configured speech", async () => {
  const { client, calls } = makeClient({ BAIDU_TTS_SERVICE: "clone" });
  assert.equal(client.isTtsConfigured(), false);
  assert.equal((await client.synthesize("当前步骤。")).error, "TTS_NOT_CONFIGURED");
  assert.equal(calls.length, 0);
});

test("HTTP 200 JSON error is never returned as audio or leaked to the browser", async () => {
  const { client } = makeClient({}, (call) => call.url.pathname.endsWith("/token")
    ? json({ access_token: "fake-access-token", expires_in: 3600 })
    : json({ err_no: 502, err_msg: "fake-project-ak fake-project-sk fake-access-token" }));
  const result = await client.synthesize("报告状态。");
  assert.equal(result.ok, false);
  assert.equal(result.error, "TTS_BAIDU_REJECTED");
  assert.equal(result.buffer, undefined);
  for (const secret of Object.values(credentials).concat("fake-access-token")) assert.ok(!JSON.stringify(result).includes(secret));
});

test("an expired-token response retries once with refreshed authentication", async () => {
  let authCalls = 0;
  let asrCalls = 0;
  const { client } = makeClient({}, (call) => call.url.pathname.endsWith("/token")
    ? json({ access_token: `fake-token-${++authCalls}`, expires_in: 3600 })
    : ++asrCalls === 1 ? json({ err_no: 111 }) : json({ err_no: 0, result: ["确认无误"] }));
  assert.equal((await client.transcribe({ audioBuffer: pcm, contentType: "audio/pcm;rate=16000" })).text, "确认无误");
  assert.equal(authCalls, 2);
  assert.equal(asrCalls, 2);
});

test("missing credentials and invalid authentication never produce a transcript", async () => {
  const missing = makeClient({ BAIDU_SECRET_KEY: "" });
  const result = await missing.client.transcribe({ audioBuffer: pcm, contentType: "audio/pcm;rate=16000" });
  assert.equal(result.error, "BAIDU_NOT_CONFIGURED");
  assert.equal(result.text, undefined);
  assert.equal(missing.calls.length, 0);
  const invalid = makeClient({}, () => json({ error: "invalid_client", error_description: "fake-project-sk" }));
  const failed = await invalid.client.transcribe({ audioBuffer: pcm, contentType: "audio/pcm;rate=16000" });
  assert.equal(failed.error, "BAIDU_AUTH_FAILED");
  assert.ok(!JSON.stringify(failed).includes("fake-project-sk"));
});

test("TTS lengths are checked before sending requests rather than silently truncating", async () => {
  const basic = makeClient();
  assert.equal((await basic.client.synthesize("稻".repeat(342))).error, "TTS_TEXT_TOO_LONG");
  assert.equal(basic.calls.length, 0);
  const clone = makeClient({ BAIDU_TTS_SERVICE: "clone", BAIDU_TTS_VOICE: "100001" });
  assert.equal((await clone.client.synthesize("a".repeat(501))).error, "TTS_TEXT_TOO_LONG");
  assert.equal(clone.calls.length, 0);
});

test("Baidu public configuration exposes format and voice metadata, never credentials", () => {
  const previous = { asr: process.env.ASR_PROVIDER, tts: process.env.TTS_PROVIDER };
  process.env.ASR_PROVIDER = "baidu";
  process.env.TTS_PROVIDER = "baidu";
  try {
    const { client } = makeClient();
    const asr = new ASRAdapterRegistry({ baiduClient: client }).getPublicConfig();
    const tts = new TTSAdapterRegistry({ baiduClient: client }).getPublicConfig();
    assert.equal(asr.input, "audio/pcm;rate=16000");
    assert.equal(asr.configured, true);
    assert.equal(tts.configured, true);
    assert.equal(tts.voice_id, 5);
    assert.ok(tts.chunking.max_utf8_bytes < 1024);
    const publicText = JSON.stringify({ asr, tts });
    for (const secret of Object.values(credentials)) assert.ok(!publicText.includes(secret));
  } finally {
    if (previous.asr === undefined) delete process.env.ASR_PROVIDER; else process.env.ASR_PROVIDER = previous.asr;
    if (previous.tts === undefined) delete process.env.TTS_PROVIDER; else process.env.TTS_PROVIDER = previous.tts;
  }
});

test("request deadline includes reading a response that stalls after headers", async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => ({ text: () => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("mock-body-timeout")), { once: true });
  }) });
  try {
    await assert.rejects(fetchWithTimeout("https://example.invalid", {}, 15, (response) => response.text()), /mock-body-timeout/u);
  } finally { global.fetch = previousFetch; }
});
