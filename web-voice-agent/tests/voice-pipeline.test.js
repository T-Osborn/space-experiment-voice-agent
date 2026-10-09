const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { ASRAdapterRegistry } = require("../server/asr-adapters");
const { TTSAdapterRegistry } = require("../server/tts-adapters");
const { AgentOrchestrator } = require("../server/agent-orchestrator");

const ENV_KEYS = [
  "ASR_PROVIDER",
  "ASR_UPSTREAM_URL",
  "ASR_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ASR_MODEL",
  "TTS_PROVIDER",
  "TTS_UPSTREAM_URL",
  "TTS_API_KEY",
  "OPENAI_TTS_MODEL",
  "OPENAI_TTS_VOICE",
  "OPENAI_TTS_SPEED",
];

function startMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withEnv(values, callback) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    return await callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("OpenAI-compatible ASR adapter sends multipart audio and returns text", async () => {
  let requestBody = Buffer.alloc(0);
  let requestType = "";
  const mock = await startMockServer((req, res) => {
    const chunks = [];
    requestType = req.headers["content-type"] || "";
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requestBody = Buffer.concat(chunks);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "切换到太空水稻在轨取样预处理实验" }));
    });
  });

  try {
    await withEnv({
      ASR_PROVIDER: "openai",
      ASR_UPSTREAM_URL: mock.url,
      OPENAI_API_KEY: "test-only-key",
    }, async () => {
      const result = await new ASRAdapterRegistry().transcribe({
        audioBuffer: Buffer.from("test-audio"),
        contentType: "audio/webm;codecs=opus",
        language: "zh-CN",
      });
      assert.equal(result.ok, true);
      assert.match(result.text, /太空水稻/u);
      assert.match(requestType, /multipart\/form-data/u);
      assert.match(requestBody.toString("utf8"), /gpt-4o-mini-transcribe/u);
      assert.match(requestBody.toString("utf8"), /recording\.webm/u);
    });
  } finally {
    await stopServer(mock.server);
  }
});

test("OpenAI-compatible TTS adapter returns audio bytes", async () => {
  let requestBody = "";
  const mock = await startMockServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requestBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(Buffer.from("ID3-test-audio"));
    });
  });

  try {
    await withEnv({
      TTS_PROVIDER: "openai",
      TTS_UPSTREAM_URL: mock.url,
      OPENAI_API_KEY: "test-only-key",
    }, async () => {
      const result = await new TTSAdapterRegistry().synthesize({ text: "请确认当前实验步骤。" });
      assert.equal(result.ok, true);
      assert.equal(result.contentType, "audio/mpeg");
      assert.equal(result.buffer.toString("utf8"), "ID3-test-audio");
      assert.match(requestBody, /gpt-4o-mini-tts/u);
      assert.match(requestBody, /请确认当前实验步骤/u);
    });
  } finally {
    await stopServer(mock.server);
  }
});

test("ASR text can enter the multi-experiment Agent and produce a voice response", async () => {
  const mockAsr = await startMockServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "切换到太空水稻在轨取样预处理实验" }));
    });
  });
  const mockTts = await startMockServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(Buffer.from("ID3-agent-response"));
    });
  });

  try {
    await withEnv({
      ASR_PROVIDER: "openai",
      ASR_UPSTREAM_URL: mockAsr.url,
      OPENAI_API_KEY: "test-only-key",
      TTS_PROVIDER: "openai",
      TTS_UPSTREAM_URL: mockTts.url,
    }, async () => {
      const asrResult = await new ASRAdapterRegistry().transcribe({
        audioBuffer: Buffer.from("test-audio"),
        contentType: "audio/webm",
        language: "zh-CN",
      });
      const orchestrator = new AgentOrchestrator();
      const session = orchestrator.createSession();
      const agentResult = await orchestrator.handleVoiceTurn({
        session,
        recognized_text: asrResult.text,
      });
      const ttsResult = await new TTSAdapterRegistry().synthesize({ text: agentResult.speech_text });

      assert.equal(asrResult.ok, true);
      assert.equal(agentResult.response_type, "EXPERIMENT_SELECTED");
      assert.equal(agentResult.experiment.experiment_id, "rice_in_orbit_preprocessing_demo");
      assert.match(agentResult.speech_text, /太空水稻/u);
      assert.equal(ttsResult.ok, true);
      assert.ok(ttsResult.buffer.length > 0);
    });
  } finally {
    await stopServer(mockAsr.server);
    await stopServer(mockTts.server);
  }
});
