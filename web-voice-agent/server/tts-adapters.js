const fs = require("node:fs");
const path = require("node:path");
const { fetchWithTimeout } = require("./http-utils");
const { defaultBaiduClient } = require("./baidu-speech");

const VOICE_CONFIG_PATH = path.join(__dirname, "..", "config", "voice.json");
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

async function readErrorPayload(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

class TTSAdapterRegistry {
  constructor({ baiduClient = defaultBaiduClient } = {}) {
    this.config = JSON.parse(fs.readFileSync(VOICE_CONFIG_PATH, "utf8"));
    this.baidu = baiduClient;
  }

  getRuntimeProvider() {
    return process.env.TTS_PROVIDER || "browser";
  }

  isConfigured() {
    const provider = this.getRuntimeProvider();
    if (provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
    if (provider === "baidu") return this.baidu.isTtsConfigured();
    if (provider === "generic_http") return Boolean(process.env.TTS_UPSTREAM_URL);
    return false;
  }

  getPublicConfig() {
    const provider = this.getRuntimeProvider();
    return {
      provider: this.config.tts.provider,
      mode: this.config.tts.mode,
      endpoint: "/api/tts/synthesize",
      language: this.config.tts.language,
      target_voice: provider === "baidu"
        ? (process.env.BAIDU_TTS_VOICE_NAME || `百度音色${this.baidu.getTtsConfig().voiceId ?? "待配置"}`)
        : this.config.tts.target_voice,
      upstream_provider: provider,
      configured: this.isConfigured(),
      browser_playback_allowed: process.env.TTS_PROVIDER === "browser",
      model: provider === "openai"
        ? (process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts")
        : null,
      output: "audio/mpeg",
      ...(provider === "baidu" ? {
        service: this.baidu.getTtsConfig().service,
        voice_id: this.baidu.getTtsConfig().voiceId,
        chunking: { max_utf8_bytes: 900, max_characters: 450 },
      } : {}),
    };
  }

  async synthesize({ text }) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) {
      return { ok: false, error: "TTS_TEXT_REQUIRED", message: "没有可播报的文本。" };
    }
    if (normalizedText.length > 4096) {
      return { ok: false, error: "TTS_TEXT_TOO_LONG", message: "播报文本超过单次语音合成长度限制。" };
    }

    const provider = this.getRuntimeProvider();
    if (!this.isConfigured()) {
      return {
        ok: false,
        error: "TTS_NOT_CONFIGURED",
        message: provider === "browser"
          ? "服务端 TTS 未配置，应该由浏览器原生语音播报。"
          : "服务端 TTS 尚未配置供应商。未生成音频。",
      };
    }

    if (provider === "openai") return this.synthesizeWithOpenAI(normalizedText);
    if (provider === "baidu") return this.baidu.synthesize(normalizedText);
    return this.synthesizeWithGenericHttp(normalizedText);
  }

  async synthesizeWithOpenAI(text) {
    try {
      const response = await fetchWithTimeout(process.env.TTS_UPSTREAM_URL || OPENAI_SPEECH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
          input: text,
          voice: process.env.OPENAI_TTS_VOICE || "sage",
          response_format: "mp3",
          speed: Number(process.env.OPENAI_TTS_SPEED || 0.95),
          instructions: "用稳定、清晰、克制的中文实验任务播报语气，不添加原文没有的信息。",
        }),
      }, Number(process.env.TTS_TIMEOUT_MS || 15000));
      if (!response.ok) {
        return {
          ok: false,
          error: "TTS_UPSTREAM_FAILED",
          upstream_status: response.status,
          detail: await readErrorPayload(response),
        };
      }
      return { ok: true, buffer: Buffer.from(await response.arrayBuffer()), contentType: "audio/mpeg" };
    } catch (error) {
      return {
        ok: false,
        error: "TTS_UPSTREAM_UNREACHABLE",
        message: "无法连接到上游 TTS 服务。未生成音频。",
        detail: error.message,
      };
    }
  }

  async synthesizeWithGenericHttp(text) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    };
    if (process.env.TTS_API_KEY) headers.Authorization = `Bearer ${process.env.TTS_API_KEY}`;
    try {
      const response = await fetchWithTimeout(process.env.TTS_UPSTREAM_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          text,
          input: text,
          language: this.config.tts.language,
          voice: process.env.TTS_VOICE || this.config.tts.target_voice,
          response_format: "mp3",
        }),
      }, Number(process.env.TTS_TIMEOUT_MS || 15000));
      if (!response.ok) {
        return {
          ok: false,
          error: "TTS_UPSTREAM_FAILED",
          upstream_status: response.status,
          detail: await readErrorPayload(response),
        };
      }
      return {
        ok: true,
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || "audio/mpeg",
      };
    } catch (error) {
      return {
        ok: false,
        error: "TTS_UPSTREAM_UNREACHABLE",
        message: "无法连接到上游 TTS 服务。未生成音频。",
        detail: error.message,
      };
    }
  }
}

module.exports = { TTSAdapterRegistry };
