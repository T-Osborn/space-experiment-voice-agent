(function (root) {
  async function request(url, options = {}, { type = "json", timeoutMs = 25000 } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timedOut = false;
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response[type]();
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      if (timedOut) throw Object.assign(new Error("REQUEST_TIMEOUT"), { retryable: true });
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  async function voiceTurn(payload) {
    const options = { method: "POST", headers: { "Content-Type": "application/json", "X-Voice-Agent-Request": "1" }, body: JSON.stringify(payload) };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await request("/api/voice/turn", options);
        if (attempt === 0 && [502, 503, 504].includes(result.status)) continue;
        return result;
      } catch (error) {
        if (attempt > 0 || !(error.retryable || error.name === "TypeError")) throw error;
      }
    }
  }
  root.VoiceNetwork = { request, voiceTurn };
  if (typeof module !== "undefined") module.exports = root.VoiceNetwork;
})(typeof window === "undefined" ? globalThis : window);
