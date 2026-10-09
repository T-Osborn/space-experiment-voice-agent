const fs = require("node:fs/promises");
const path = require("node:path");
const { BaiduSpeechClient } = require("../server/baidu-speech");
const { fetchWithTimeout } = require("../server/http-utils");

const LIST_URL = "https://aip.baidubce.com/rest/2.0/speech/publiccloudspeech/v1/voice/clone/list";
const SOURCE_URL = "https://ai.baidu.com/ai-doc/SPEECH/mmj9xwpo5";

function safeName(value, secrets) {
  if (typeof value !== "string") return "";
  let name = value;
  for (const secret of secrets.filter(Boolean)) name = name.split(secret).join("[redacted]");
  return name.replace(/https?:\/\/\S+/giu, "[link omitted]").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").slice(0, 80);
}

async function discoverBaiduVoices({ env = () => process.env, request = fetchWithTimeout, now = () => new Date(), maxPages = 10, maxVoices = 500 } = {}) {
  const credentials = env();
  const client = new BaiduSpeechClient({ env: () => credentials, request });
  const result = {
    schema_version: 1,
    checked_at: now().toISOString(),
    provider: "baidu",
    source: SOURCE_URL,
    authenticated: false,
    auth_error: null,
    clone_list: { status: "not_checked", total: null, pages_read: 0, voices: [], error: null },
    ordinary_voice_selection: "not_discoverable_from_credentials",
    selected_voice: null,
    selection_required: true,
    real_asr_verified: false,
    real_tts_verified: false,
  };
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10 || !Number.isSafeInteger(maxVoices) || maxVoices < 1 || maxVoices > 500) {
    throw new Error("QUERY_LIMIT_INVALID");
  }
  let token;
  try {
    token = await client.getToken();
    result.authenticated = true;
  } catch (error) {
    result.auth_error = ["BAIDU_NOT_CONFIGURED", "BAIDU_AUTH_FAILED", "BAIDU_RESPONSE_INVALID"].includes(error.code)
      ? error.code : "BAIDU_AUTH_UNREACHABLE";
    return result;
  }
  const secrets = [credentials.BAIDU_API_KEY, credentials.BAIDU_SECRET_KEY, token];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const url = new URL(LIST_URL);
      url.searchParams.set("access_token", token);
      const reply = await client.jsonRequest(url, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ page }),
      }, 15000);
      if (!reply.ok || reply.payload.status !== 0) throw new Error("BAIDU_VOICE_LIST_REJECTED");
      const data = reply.payload.data;
      if (!data || !Number.isSafeInteger(data.total) || data.total < 0 || data.page !== page
        || !Number.isSafeInteger(data.page_size) || data.page_size < (data.total > 0 ? 1 : 0)
        || !Array.isArray(data.items) || data.items.length > data.page_size
        || (page > 1 && result.clone_list.total !== data.total)) throw new Error("BAIDU_VOICE_LIST_INVALID");
      // Validate the whole page before adding any of it; raw provider messages are never retained.
      const pageIds = new Set();
      const voices = data.items.map((item) => {
        if (!item || !Number.isSafeInteger(item.voice_id) || item.voice_id <= 0 || item.status !== 0
          || seen.has(item.voice_id) || pageIds.has(item.voice_id)) throw new Error("BAIDU_VOICE_LIST_INVALID");
        pageIds.add(item.voice_id);
        return { voice_id: item.voice_id, voice_name: safeName(item.voice_name, secrets), lang: ["zh", "ja"].includes(item.lang) ? item.lang : "unknown" };
      });
      if (seen.size + voices.length > data.total || (voices.length === 0 && seen.size < data.total)) throw new Error("BAIDU_VOICE_LIST_INVALID");
      result.clone_list.total = data.total;
      result.clone_list.pages_read += 1;
      for (const voice of voices) {
        if (result.clone_list.voices.length >= maxVoices) break;
        seen.add(voice.voice_id);
        result.clone_list.voices.push(voice);
      }
      if (seen.size === data.total) { result.clone_list.status = "complete"; break; }
      result.clone_list.status = "partial";
      if (result.clone_list.voices.length >= maxVoices || page === maxPages) {
        result.clone_list.error = "QUERY_LIMIT_REACHED";
        break;
      }
    } catch (error) {
      result.clone_list.status = result.clone_list.pages_read ? "partial" : "failed";
      result.clone_list.error = ["BAIDU_VOICE_LIST_REJECTED", "BAIDU_VOICE_LIST_INVALID", "BAIDU_RESPONSE_INVALID"].includes(error.message)
        ? error.message : error.code === "BAIDU_RESPONSE_INVALID" ? error.code : "BAIDU_VOICE_LIST_UNREACHABLE";
      break;
    }
  }
  client.cachedToken = null;
  return result;
}

async function main() {
  let result;
  try { result = await discoverBaiduVoices(); }
  catch { process.stderr.write("VOICE_QUERY_FAILED: No raw credentials or provider errors are printed.\n"); process.exitCode = 1; return; }
  finally {
    delete process.env.BAIDU_API_KEY;
    delete process.env.BAIDU_SECRET_KEY;
  }
  const reportPath = path.resolve(__dirname, "../../docs/baidu-voice-discovery-latest.json");
  try {
    await fs.writeFile(reportPath, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "w" });
    process.stdout.write(`Safe report: ${reportPath}\n`);
  } catch { process.stderr.write("SAFE_REPORT_NOT_SAVED: The result is printed below; no key file was written.\n"); process.exitCode = 1; }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.stdout.write("No voice was selected. Recognition and speech playback have not been tested.\n");
  if (!result.authenticated || result.clone_list.status !== "complete") process.exitCode = 1;
}

if (require.main === module) main().catch(() => { process.stderr.write("VOICE_QUERY_FAILED\n"); process.exitCode = 1; });
module.exports = { discoverBaiduVoices, safeName, LIST_URL };
