const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { encodePcm16, splitSpeechText, toBaiduPcm } = require("../public/audio-tools");

test("PCM output is mono, signed 16-bit little endian and clips out-of-range samples", () => {
  const samples = new Float32Array([-2, -1, 0, 0.5, 1, 2, NaN]);
  const bytes = encodePcm16([samples]);
  const view = new DataView(bytes);
  assert.equal(bytes.byteLength, samples.length * 2);
  assert.deepEqual(Array.from({ length: samples.length }, (_, index) => view.getInt16(index * 2, true)), [-32768, -32768, 0, 16384, 32767, 32767, 0]);
  const mono = new DataView(encodePcm16([new Float32Array([1]), new Float32Array([-1])]));
  assert.equal(mono.getInt16(0, true), 0);
});

test("speech chunks preserve the complete original text within byte and character limits", () => {
  const text = "请核对数值。" + "水稻😀负八十点五摄氏度".repeat(100) + "实验状态已记录。";
  const chunks = splitSpeechText(text);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 900);
    assert.ok([...chunk].length <= 450);
    assert.ok(!chunk.includes("\uFFFD"));
  }
});

test("browser decode contract requests 16k and mixes the resampled channels", async () => {
  const original = global.OfflineAudioContext;
  global.OfflineAudioContext = class {
    constructor(channels, frames, rate) { assert.equal(rate, 16000); }
    async decodeAudioData() {
      return { sampleRate: 16000, length: 2, duration: 2 / 16000, numberOfChannels: 2,
        getChannelData: (index) => index === 0 ? new Float32Array([1, 0]) : new Float32Array([-1, 0]) };
    }
  };
  try {
    const blob = await toBaiduPcm(new Blob(["mock-recorded-container"]));
    assert.equal(blob.type, "audio/pcm;rate=16000");
    assert.equal(blob.size, 4);
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 0, 0, 0]);
  } finally {
    if (original === undefined) delete global.OfflineAudioContext; else global.OfflineAudioContext = original;
  }
});

function createPlaybackHarness(ttsHandler, voiceOverrides = {}) {
  const elements = new Map();
  const audios = [];
  const urls = new Set();
  const config = { asr: { configured: false }, tts: { configured: true, endpoint: "/api/tts/synthesize", chunking: { max_utf8_bytes: 900, max_characters: 450 } }, ...voiceOverrides };
  const context = vm.createContext({
    Blob, AbortController, TextEncoder, setTimeout, clearTimeout,
    VoiceAudioTools: { splitSpeechText },
    navigator: { mediaDevices: { getUserMedia() {} } },
    window: { MediaRecorder: class {}, speechSynthesis: { cancel() {}, speak() {} } },
    document: { createElement: () => ({ children: [], append(child) { this.children.push(child); } }), querySelector: (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", classList: { toggle() {} }, addEventListener() {} });
      return elements.get(id);
    } },
    URL: { createObjectURL: () => { const url = `blob:test-${urls.size}-${audios.length}`; urls.add(url); return url; }, revokeObjectURL: (url) => urls.delete(url) },
    Audio: class {
      constructor(url) { this.url = url; audios.push(this); }
      play() { return Promise.resolve(); }
      pause() {}
    },
    fetch: async (url, options) => {
      if (url === "/api/access") return { ok: true, json: async () => ({ ok: true }) };
      if (url === "/api/voice/config") return { ok: true, json: async () => config };
      if (url === "/api/readiness") return { ok: true, json: async () => ({
        configuration_ready: config.asr.configured && config.tts.configured,
        message: config.tts.configured ? "还需补齐：语音识别配置。" : "还需补齐：所选音色配置。",
      }) };
      if (url === "/api/session") return { ok: true, json: async () => ({ status: "IDLE" }) };
      if (url === "/api/capabilities") return { ok: true, json: async () => ({}) };
      if (url === "/api/experiments") return { ok: true, json: async () => ({ experiments: [] }) };
      if (url === "/api/procedures") return { ok: true, json: async () => ({ procedures: [] }) };
      return ttsHandler(url, options);
    },
  });
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/voice-network.js"), "utf8"), context);
  vm.runInContext(source + "\nglobalThis.testApi = { speak, stopPlayback, startRecording, stopRecording, downloadRecord, showRecordHistory }; globalThis.testReady = bootstrapReady;", context);
  return { api: context.testApi, audios, urls, ready: context.testReady, elements, context };
}

async function drain() { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }

test("archive download links stay same-origin and a fresh history replaces old links", async () => {
  const harness = createPlaybackHarness(() => { throw new Error("no speech request expected"); });
  await harness.ready;
  const list = harness.context.document.querySelector("#recordHistory");
  list.children = []; list.replaceChildren = () => { list.children = []; };
  list.append = item => list.children.push(item);
  const id = `session_${"a".repeat(48)}-3`;
  harness.api.showRecordHistory([{ id, experiment_name: "<script>fixture</script>", completed_steps: 1, created_at: "2026-10-09",
    download_url: "https://external.invalid/ignored" }, { id: "../escape", experiment_name: "invalid" }]);
  assert.equal(list.children.length, 1);
  const link = list.children[0].children[0];
  assert.equal(link.href, `/api/records/${id}`);
  assert.match(link.textContent, /<script>fixture<\/script>/u);
  assert.equal(link.innerHTML, undefined);
  harness.api.showRecordHistory([]);
  assert.equal(list.hidden, true); assert.equal(list.children.length, 0);
});

test("selected server voice failure never silently speaks with a browser voice", async () => {
  const harness = createPlaybackHarness(async () => ({ ok: false, blob: async () => new Blob() }));
  let browserSpeaks = 0;
  harness.context.window.speechSynthesis.speak = () => { browserSpeaks += 1; };
  await harness.ready;
  await harness.api.speak("核对记录");
  assert.equal(browserSpeaks, 0);
  assert.equal(harness.audios.length, 0);
  assert.match(harness.elements.get("#supportMessage").textContent, /未切换音色/u);
});

test("double-clicking while waiting for microphone permission opens only one recorder", async () => {
  const harness = createPlaybackHarness(() => { throw new Error("unexpected upload"); });
  await harness.ready;
  let allow;
  let microphoneRequests = 0;
  harness.context.navigator.mediaDevices.getUserMedia = () => {
    microphoneRequests++;
    return new Promise(resolve => { allow = () => resolve({ getTracks: () => [] }); });
  };
  harness.context.MediaRecorder = class { constructor() { this.state = "inactive"; } start() { this.state = "recording"; } };
  const first = harness.api.startRecording();
  await harness.api.startRecording();
  assert.equal(microphoneRequests, 1);
  assert.equal(harness.elements.get("#voiceButton").disabled, true);
  allow(); await first;
  assert.equal(harness.elements.get("#voiceButton").disabled, false);
  assert.equal(harness.elements.get("#voiceButtonLabel").textContent, "提交语音");
});

test("recording is disabled while recognition is configured but the selected voice is missing", async () => {
  const harness = createPlaybackHarness(() => { throw new Error("unexpected speech upload"); },
    { asr: { configured: true }, tts: { configured: false } });
  await harness.ready;
  assert.equal(harness.elements.get("#voiceButton").disabled, true);
  assert.match(harness.elements.get("#supportMessage").textContent, /所选音色配置/u);
});

test("a recorder error or microphone disconnect discards partial audio and allows a fresh recording", async () => {
  const harness = createPlaybackHarness(() => { throw new Error("partial audio must not upload"); });
  await harness.ready;
  let deviceEnded;
  let tracksStopped = 0;
  const track = { stop: () => { tracksStopped++; }, addEventListener: (name, handler) => { assert.equal(name, "ended"); deviceEnded = handler; } };
  harness.context.navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track] });
  const recorders = [];
  harness.context.MediaRecorder = class {
    constructor() { this.state = "inactive"; recorders.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop?.(); }
  };
  await harness.api.startRecording();
  const first = recorders[0];
  first.ondataavailable({ data: new Blob(["partial fixture"]) });
  first.onerror({ error: new Error("fixture device failure") });
  assert.equal(first.state, "inactive");
  assert.equal(tracksStopped, 1);
  assert.equal(harness.elements.get("#voiceButton").disabled, false);
  assert.match(harness.elements.get("#supportMessage").textContent, /没有提交/u);
  await harness.api.startRecording();
  assert.equal(recorders.length, 2);
  deviceEnded();
  assert.equal(recorders[1].state, "inactive");
  assert.equal(tracksStopped, 2);
});

test("empty recording never reaches recognition or the task engine", async () => {
  const harness = createPlaybackHarness(() => { throw new Error("empty audio must not upload"); });
  await harness.ready;
  let trackStops = 0;
  harness.context.navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop: () => { trackStops++; } }] });
  harness.context.MediaRecorder = class {
    constructor() { this.state = "inactive"; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop?.(); }
  };
  await harness.api.startRecording(); harness.api.stopRecording();
  assert.equal(trackStops, 1);
  assert.equal(harness.elements.get("#voiceButton").disabled, false);
  assert.match(harness.elements.get("#status").textContent, /未采集到录音/u);
});

test("voice record export offers a download link and releases the previous generated file", async () => {
  const harness = createPlaybackHarness(() => { throw new Error("unexpected request"); });
  await harness.ready;
  const link = harness.context.document.querySelector("#recordDownload");
  let clicks = 0; link.click = () => { clicks++; };
  harness.api.downloadRecord({ filename: "task-one.json", data: { confirmed: false } });
  assert.equal(link.download, "task-one.json");
  assert.equal(link.hidden, false);
  harness.api.downloadRecord({ filename: "task-two.json", data: { confirmed: true } });
  assert.equal(clicks, 2);
  assert.equal(link.download, "task-two.json");
  assert.equal(harness.urls.size, 1);
});

test("segmented playback waits for the previous audio and releases each URL", async () => {
  const requested = [];
  const harness = createPlaybackHarness(async (url, options) => {
    requested.push(JSON.parse(options.body).text);
    return { ok: true, blob: async () => new Blob(["mock-audio"], { type: "audio/mpeg" }) };
  });
  await harness.ready;
  const speaking = harness.api.speak("第一句。第二句。");
  await drain();
  assert.deepEqual(requested, ["第一句。"]);
  assert.equal(harness.audios.length, 1);
  harness.audios[0].onended();
  await drain();
  assert.deepEqual(requested, ["第一句。", "第二句。"]);
  harness.audios[1].onended();
  await speaking;
  assert.equal(harness.urls.size, 0);
});

test("stopping during a pending TTS request cannot start playback afterward", async () => {
  let complete;
  let signal;
  const harness = createPlaybackHarness((url, options) => {
    signal = options.signal;
    return new Promise((resolve) => { complete = resolve; });
  });
  await harness.ready;
  const speaking = harness.api.speak("请核对。下一步。");
  await drain();
  harness.api.stopPlayback();
  assert.equal(signal.aborted, true);
  complete({ ok: true, blob: async () => new Blob(["mock-audio"]) });
  await speaking;
  assert.equal(harness.audios.length, 0);
  assert.equal(harness.urls.size, 0);
});

test("stopping during playback ends the queue and releases the audio URL", async () => {
  let calls = 0;
  const harness = createPlaybackHarness(async () => {
    calls += 1;
    return { ok: true, blob: async () => new Blob(["mock-audio"]) };
  });
  await harness.ready;
  const speaking = harness.api.speak("第一句。第二句。");
  await drain();
  harness.api.stopPlayback();
  await speaking;
  assert.equal(calls, 1);
  assert.equal(harness.urls.size, 0);
});
