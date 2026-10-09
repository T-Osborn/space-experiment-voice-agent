async function fetchWithTimeout(url, options = {}, timeoutMs = 15000, consumeResponse = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return consumeResponse ? await consumeResponse(response) : response;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
