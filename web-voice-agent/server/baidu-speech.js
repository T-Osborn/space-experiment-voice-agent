const { createHash, randomUUID } = require("node:crypto");
const { fetchWithTimeout } = require("./http-utils");

const URLS = {
  token: "https://aip.baidubce.com/oauth/2.0/token",
  asr: "https://vop.baidu.com/server_api",
  short_text: "https://tsn.baidu.com/text2audio",
  clone: "https://aip.baidubce.com/rest/2.0/speech/publiccloudspeech/v1/voice/clone/tts",
};

class SpeechError extends Error {
  constructor(code, message, upstreamCode = null) {
    super(message);
    this.code = code;
    this.upstreamCode = typeof upstreamCode === "number" ? upstreamCode : null;
  }
}

function integerOption(value, fallback, min, max) {
  const number = value === undefined || value === "" ? fallback : Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

class BaiduSpeechClient {
  constructor({ env = () => process.env, request = fetchWithTimeout, now = Date.now } = {}) {
    this.env = env;
    this.request = request;
    this.now = now;
    this.cuid = `voice-agent-${randomUUID()}`;
    this.cachedToken = null;
    this.pendingToken = null;
  }

  isConfigured() {
    const env = this.env();
    return Boolean(env.BAIDU_API_KEY?.trim() && env.BAIDU_SECRET_KEY?.trim());
  }

  getTtsConfig() {
    const env = this.env();
    const service = env.BAIDU_TTS_SERVICE || "short_text";
    return {
      service,
      voiceId: integerOption(env.BAIDU_TTS_VOICE, service === "clone" ? null : 5, 0, Number.MAX_SAFE_INTEGER),
      speed: integerOption(env.BAIDU_TTS_SPEED, 5, 0, 15),
      pitch: integerOption(env.BAIDU_TTS_PITCH, 5, 0, 15),
      volume: integerOption(env.BAIDU_TTS_VOLUME, 5, 0, service === "clone" ? 15 : 9),
    };
  }

  isTtsConfigured() {
    const config = this.getTtsConfig();
    return this.isConfigured() && ["short_text", "clone"].includes(config.service)
      && [config.voiceId, config.speed, config.pitch, config.volume].every((value) => value !== null)
      && (config.service !== "clone" || config.voiceId > 0);
  }

  getCuid() {
    const value = this.env().BAIDU_CUID || this.cuid;
    if (value.length > 60) throw new SpeechError("BAIDU_CONFIG_INVALID", "百度语音用户标识不能超过60个字符。");
    return value;
  }

  async jsonRequest(url, options, timeoutMs) {
    return this.request(url, { ...options, redirect: "error" }, timeoutMs, async (response) => {
      let payload;
      try { payload = JSON.parse(await response.text()); }
      catch { throw new SpeechError("BAIDU_RESPONSE_INVALID", "百度语音服务没有返回有效的接口结果。"); }
      return { ok: response.ok, status: response.status, payload };
    });
  }

  async getToken(force = false) {
    if (!this.isConfigured()) throw new SpeechError("BAIDU_NOT_CONFIGURED", "尚未配置百度语音应用的API Key和Secret Key。");
    const env = this.env();
    const key = createHash("sha256").update(env.BAIDU_API_KEY).update("\0").update(env.BAIDU_SECRET_KEY).digest("hex");
    if (force && this.cachedToken?.key === key) this.cachedToken = null;
    if (this.cachedToken?.key === key && this.cachedToken.expiresAt > this.now()) return this.cachedToken.token;
    if (this.pendingToken?.key === key) return this.pendingToken.promise;
    const promise = (async () => {
      const url = new URL(URLS.token);
      url.search = new URLSearchParams({ grant_type: "client_credentials", client_id: env.BAIDU_API_KEY, client_secret: env.BAIDU_SECRET_KEY }).toString();
      const result = await this.jsonRequest(url, { method: "POST", headers: { Accept: "application/json" } }, 15000);
      const { access_token: token, expires_in: expiresIn } = result.payload;
      if (!result.ok || result.payload.error || typeof token !== "string" || !token || !Number.isFinite(Number(expiresIn)) || Number(expiresIn) <= 0) {
        throw new SpeechError("BAIDU_AUTH_FAILED", "百度语音鉴权失败，请检查应用凭证及服务开通状态。");
      }
      const lifetimeMs = Number(expiresIn) * 1000;
      this.cachedToken = { key, token, expiresAt: this.now() + lifetimeMs - Math.min(60000, lifetimeMs * 0.1) };
      return token;
    })();
    this.pendingToken = { key, promise };
    try { return await promise; }
    finally { if (this.pendingToken?.promise === promise) this.pendingToken = null; }
  }

  safeFailure(error, stage) {
    // Never return raw upstream messages, request URLs, tokens or credentials to the browser.
    if (error instanceof SpeechError) return { ok: false, error: error.code, message: error.message, ...(error.upstreamCode !== null ? { upstream_code: error.upstreamCode } : {}) };
    return { ok: false, error: `${stage}_UPSTREAM_UNREACHABLE`, message: "百度语音请求失败或超时，请检查网络连接后重试。" };
  }

  async transcribe({ audioBuffer, contentType }) {
    try {
      if (!/^audio\/pcm\s*;\s*rate=16000\s*$/iu.test(String(contentType))) {
        throw new SpeechError("ASR_AUDIO_FORMAT_INVALID", "百度识别需要16kHz单声道16位PCM音频，当前录音格式不匹配。");
      }
      if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length || audioBuffer.length % 2) {
        throw new SpeechError("ASR_AUDIO_INVALID", "PCM录音为空或长度不正确，请重新录音。");
      }
      if (audioBuffer.length > 16000 * 2 * 60) throw new SpeechError("ASR_AUDIO_TOO_LONG", "单次录音不能超过60秒，请分段报告。");
      const devPid = integerOption(this.env().BAIDU_ASR_DEV_PID, 1537, 1, Number.MAX_SAFE_INTEGER);
      if (devPid === null) throw new SpeechError("BAIDU_CONFIG_INVALID", "百度识别模型编号配置不正确。");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await this.getToken(attempt > 0);
        const result = await this.jsonRequest(URLS.asr, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ format: "pcm", rate: 16000, channel: 1, cuid: this.getCuid(), token, dev_pid: devPid, len: audioBuffer.length, speech: audioBuffer.toString("base64") }),
        }, Number(this.env().ASR_TIMEOUT_MS || 15000));
        const code = result.payload.err_no;
        if ([110, 111, 3302].includes(code) && attempt === 0) continue;
        if (!result.ok || code !== 0) {
          throw new SpeechError("ASR_BAIDU_REJECTED", code === 3301 ? "没有识别到清晰语音，请靠近麦克风重新报告。" : "百度语音识别未成功，请检查接口权限、额度或录音质量。", code);
        }
        const text = result.payload.result?.[0];
        if (typeof text !== "string" || !text.trim()) throw new SpeechError("ASR_EMPTY_RESULT", "没有识别到可用文字，请重新报告。");
        return { ok: true, text: text.trim() };
      }
    } catch (error) { return this.safeFailure(error, "ASR"); }
  }

  async synthesize(text) {
    try {
      const config = this.getTtsConfig();
      if (!this.isTtsConfigured()) throw new SpeechError("TTS_NOT_CONFIGURED", "百度播报配置尚未齐全，请检查应用凭证、服务类型和音色编号。");
      // UTF-8 is a conservative byte limit for the documented GBK short-text limit.
      if (config.service === "short_text" && Buffer.byteLength(text, "utf8") >= 1024) throw new SpeechError("TTS_TEXT_TOO_LONG", "播报文本需要分段后合成。");
      if (config.service === "clone" && [...text].length > 500) throw new SpeechError("TTS_TEXT_TOO_LONG", "声音复刻单次文本不能超过500个字符，需要分段合成。");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await this.getToken(attempt > 0);
        let url = URLS.short_text;
        let options;
        if (config.service === "clone") {
          const cloneUrl = new URL(URLS.clone);
          cloneUrl.searchParams.set("access_token", token);
          url = cloneUrl;
          options = {
            method: "POST", headers: { "Content-Type": "application/json", Accept: "audio/mp3" },
            body: JSON.stringify({ text, voice_id: config.voiceId, lang: "zh", media_type: "mp3", speed: config.speed, pitch: config.pitch, volume: config.volume }),
          };
        } else {
          options = {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "audio/mpeg, application/json" },
            body: new URLSearchParams({ tex: encodeURIComponent(text), tok: token, cuid: this.getCuid(), ctp: "1", lan: "zh", per: String(config.voiceId), spd: String(config.speed), pit: String(config.pitch), vol: String(config.volume), aue: "3" }).toString(),
          };
        }
        const result = await this.request(url, { ...options, redirect: "error" }, Number(this.env().TTS_TIMEOUT_MS || 15000), async (response) => {
          const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          if (response.ok && ["audio/mpeg", "audio/mp3"].includes(contentType)) {
            const buffer = Buffer.from(await response.arrayBuffer());
            if (!buffer.length) throw new SpeechError("TTS_AUDIO_EMPTY", "百度没有返回可播放音频。");
            return { audio: buffer };
          }
          let payload = {};
          try { payload = JSON.parse(await response.text()); } catch { /* safe generic error below */ }
          return { code: payload.err_no ?? payload.error_code ?? payload.status };
        });
        if (result.audio) return { ok: true, buffer: result.audio, contentType: "audio/mpeg" };
        if ([110, 111].includes(result.code) && attempt === 0) continue;
        throw new SpeechError("TTS_BAIDU_REJECTED", "百度语音合成未成功，请检查音色编号、接口权限及可用额度。", result.code);
      }
    } catch (error) { return this.safeFailure(error, "TTS"); }
  }
}

const defaultBaiduClient = new BaiduSpeechClient();
module.exports = { BaiduSpeechClient, defaultBaiduClient };
