const fs = require("node:fs");
const path = require("node:path");
const { fetchWithTimeout } = require("./http-utils");
const { defaultBaiduClient } = require("./baidu-speech");

const VOICE_CONFIG_PATH = path.join(__dirname, "..", "config", "voice.json");
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";

function getFileExtension(contentType) {
  const normalized = String(contentType || "audio/webm").toLowerCase();
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("flac")) return "flac";
  return "webm";
}

function buildMultipartBody(fields, file) {
  const boundary = `----voice-agent-${Date.now().toString(16)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(`${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(Buffer.from(
    `Content-Disposition: form-data; name="file"; filename="recording.${file.extension}"\r\n` +
    `Content-Type: ${file.contentType}\r\n\r\n`
  ));
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    boundary,
    body: Buffer.concat(chunks),
  };
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

class ASRAdapterRegistry {
  constructor({ baiduClient = defaultBaiduClient } = {}) {
    this.config = JSON.parse(fs.readFileSync(VOICE_CONFIG_PATH, "utf8"));
    this.baidu = baiduClient;
  }

  getRuntimeProvider() {
    return process.env.ASR_PROVIDER || "generic_http";
  }

  isConfigured() {
    if (this.getRuntimeProvider() === "openai") return Boolean(process.env.OPENAI_API_KEY);
    if (this.getRuntimeProvider() === "baidu") return this.baidu.isConfigured();
    return Boolean(process.env.ASR_UPSTREAM_URL);
  }

  getPublicConfig() {
    const runtimeProvider = this.getRuntimeProvider();
    return {
      provider: this.config.asr.provider,
      mode: this.config.asr.mode,
      endpoint: this.config.asr.endpoint,
      language: this.config.asr.language,
      input: runtimeProvider === "baidu" ? "audio/pcm;rate=16000" : this.config.asr.input,
      sample_rate: runtimeProvider === "baidu" ? 16000 : null,
      max_recording_seconds: runtimeProvider === "baidu" ? 55 : null,
      upstream_provider: runtimeProvider,
      model: runtimeProvider === "openai"
        ? (process.env.OPENAI_ASR_MODEL || "gpt-4o-mini-transcribe")
        : runtimeProvider === "baidu" ? String(process.env.BAIDU_ASR_DEV_PID || 1537) : null,
      configured: this.isConfigured(),
    };
  }

  async transcribe({ audioBuffer, contentType, language }) {
    if (!this.isConfigured()) {
      return {
        ok: false,
        error: "ASR_NOT_CONFIGURED",
        message: this.getRuntimeProvider() === "openai"
          ? "服务端 ASR 已选择 OpenAI 适配器，但尚未配置 OPENAI_API_KEY。未生成或伪造识别文本。"
          : this.getRuntimeProvider() === "baidu"
            ? "百度语音识别尚未配置应用凭证，请在本机或服务器配置API Key和Secret Key。"
          : "服务端 ASR 尚未配置上游识别服务。未生成或伪造识别文本。",
      };
    }

    if (this.getRuntimeProvider() === "openai") {
      return this.transcribeWithOpenAI({ audioBuffer, contentType, language });
    }

    if (this.getRuntimeProvider() === "baidu") return this.baidu.transcribe({ audioBuffer, contentType });

    return this.transcribeWithGenericHttp({ audioBuffer, contentType, language });
  }

  async transcribeWithGenericHttp({ audioBuffer, contentType, language }) {
    const upstreamUrl = process.env.ASR_UPSTREAM_URL;

    const headers = {
      "Content-Type": contentType || "audio/webm",
      "Accept": "application/json",
      "X-ASR-Language": language || this.config.asr.language,
    };
    if (process.env.ASR_API_KEY) headers.Authorization = `Bearer ${process.env.ASR_API_KEY}`;

    try {
      const response = await fetchWithTimeout(upstreamUrl, {
        method: "POST",
        headers,
        body: audioBuffer,
      }, Number(process.env.ASR_TIMEOUT_MS || 15000));
      const payload = await parseResponse(response);
      return this.normalizeResponse(response, payload);
    } catch (error) {
      return {
        ok: false,
        error: "ASR_UPSTREAM_UNREACHABLE",
        message: "无法连接到上游 ASR 服务。未生成或伪造识别文本。",
        detail: error.message,
      };
    }
  }

  async transcribeWithOpenAI({ audioBuffer, contentType, language }) {
    const openAiLanguage = String(language || this.config.asr.language || "zh-CN").split("-")[0];
    const fileContentType = String(contentType || "audio/webm").split(";")[0];
    const multipart = buildMultipartBody(
      {
        model: process.env.OPENAI_ASR_MODEL || "gpt-4o-mini-transcribe",
        language: openAiLanguage,
        response_format: "json",
        prompt: "太空实验、载荷实验、在轨取样预处理、样品、培养、营养液、MELFI、冷冻保存、时间戳、设备编号。",
      },
      {
        buffer: audioBuffer,
        contentType: fileContentType,
        extension: getFileExtension(fileContentType),
      }
    );

    try {
      const response = await fetchWithTimeout(process.env.ASR_UPSTREAM_URL || OPENAI_TRANSCRIPTIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
          Accept: "application/json",
        },
        body: multipart.body,
      }, Number(process.env.ASR_TIMEOUT_MS || 15000));
      const payload = await parseResponse(response);
      return this.normalizeResponse(response, payload);
    } catch (error) {
      return {
        ok: false,
        error: "ASR_UPSTREAM_UNREACHABLE",
        message: "无法连接到 OpenAI ASR 服务。未生成或伪造识别文本。",
        detail: error.message,
      };
    }
  }

  normalizeResponse(response, payload) {

    if (!response.ok) {
      return {
        ok: false,
        error: "ASR_UPSTREAM_FAILED",
        upstream_status: response.status,
        detail: payload,
      };
    }

    const recognizedText = payload.text || payload.transcript || payload.result;
    if (typeof recognizedText !== "string" || recognizedText.trim() === "") {
      return {
        ok: false,
        error: "ASR_EMPTY_RESULT",
        message: "上游 ASR 未返回可用文本。",
      };
    }

    return { ok: true, text: recognizedText.trim() };
  }
}

module.exports = { ASRAdapterRegistry };
