const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { AgentOrchestrator } = require("./agent-orchestrator");
const { VoiceAdapterRegistry } = require("./voice-adapters");
const { ASRAdapterRegistry } = require("./asr-adapters");
const { TTSAdapterRegistry } = require("./tts-adapters");
const { ROUTES } = require("./exception-assistant");
const { classifyVoiceIntent } = require("./voice-intents");
const { summarizeReadiness } = require("./readiness");
const { behaviorPolicy } = require("./behavior-policy");
const { version: applicationVersion } = require("../package.json");
const { deploymentConfig, DemoAccess, SessionStore, assertSameOrigin, setSecurityHeaders, failure } = require("./deployment-security");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ["/audio-tools.js", ["audio-tools.js", "text/javascript; charset=utf-8"]],
  ["/voice-network.js", ["voice-network.js", "text/javascript; charset=utf-8"]],
]);

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes) {
  if (Number(req.headers["content-length"]) > maxBytes) { req.resume(); return Promise.reject(failure("REQUEST_TOO_LARGE", 413)); }
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(failure("REQUEST_TIMEOUT", 408)), 10000);
    req.on("data", (chunk) => {
      if (finished) return;
      total += chunk.length;
      if (total > maxBytes) finish(failure("REQUEST_TOO_LARGE", 413)); else chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks)));
    req.on("error", () => finish(failure("REQUEST_ABORTED", 400)));
    req.on("aborted", () => finish(failure("REQUEST_ABORTED", 400)));
  });
}

async function readJson(req, maxBytes = 32768) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw failure("JSON_CONTENT_TYPE_REQUIRED", 415);
  try {
    const value = JSON.parse((await readBody(req, maxBytes)).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) { if (error.status) throw error; throw failure("INVALID_JSON"); }
}

function speechFailure(result) {
  const code = /^[A-Z0-9_]+$/u.test(result.error || "") ? result.error : "SPEECH_SERVICE_FAILED";
  return { ok: false, error: code, message: code.endsWith("NOT_CONFIGURED")
    ? "语音服务尚未配置；未生成识别结果或音频。" : "语音服务未完成请求，请检查配置或稍后重试。" };
}

function createApp({ config = deploymentConfig(), orchestrator = new AgentOrchestrator(),
  voiceAdapters = new VoiceAdapterRegistry(), asrAdapters = new ASRAdapterRegistry(),
  ttsAdapters = new TTSAdapterRegistry(), access = new DemoAccess(config), sessions = new SessionStore() } = {}) {
  const { knowledgeRetriever, experimentRegistry, procedureRegistry } = orchestrator;
  let activeSpeech = 0;
  async function speechWork(handler) {
    if (activeSpeech >= 4) throw failure("SPEECH_CAPACITY_REACHED", 503);
    activeSpeech += 1;
    try { return await handler(); } finally { activeSpeech -= 1; }
  }
  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res, config);
    try {
      const url = new URL(req.url, "http://localhost");
      const route = url.pathname;
      if (req.method === "GET" && route === "/api/health") return json(res, 200, { ok: true, service: "space-experiment-voice-agent" });
      if (req.method === "GET" && STATIC_FILES.has(route)) {
        const [filename, type] = STATIC_FILES.get(route);
        const data = await fs.promises.readFile(path.join(PUBLIC_DIR, filename));
        res.writeHead(200, { "Content-Type": type, "Content-Length": data.length }); res.end(data); return;
      }
      if (!route.startsWith("/api/")) throw failure("NOT_FOUND", 404);
      if (req.method === "POST") assertSameOrigin(req, config);
      if (req.method === "POST" && route === "/api/access") {
        const payload = await readJson(req, 2048);
        access.grant(req, res, payload.token);
        return json(res, 200, { ok: true, access_mode: config.production ? "RESTRICTED_DEMO" : "LOCAL_DEMO" });
      }
      const owner = access.owner(req); access.checkRate(owner);
      if (req.method === "POST" && route === "/api/session") {
        await readJson(req, 2048);
        return json(res, 200, sessions.create(owner, orchestrator.createSession()));
      }
      if (req.method === "GET" && route === "/api/progress") {
        const session = sessions.get(url.searchParams.get("session_id"), owner).session;
        const procedure = procedureRegistry.getForExperiment(session.experiment_id);
        return json(res, 200, { progress: procedure ? orchestrator.procedureEngine.progress(session, procedure) : null });
      }
      if (req.method === "GET" && route === "/api/persona") return json(res, 200, orchestrator.persona);
      if (req.method === "GET" && route === "/api/records") return json(res, 200, {
        enabled: Boolean(sessions.repository), records: sessions.repository?.history(owner) || [],
      });
      if (req.method === "GET" && /^\/api\/records\/session_[a-f0-9]{48}-\d{1,16}$/u.test(route)) {
        if (!sessions.repository) throw failure("RECORD_STORAGE_NOT_ENABLED", 404);
        const id = route.split("/").at(-1);
        const record = sessions.repository.archive(id, owner);
        res.setHeader("Content-Disposition", `attachment; filename="experiment-${id}.json"`);
        return json(res, 200, record);
      }
      if (req.method === "GET" && route === "/api/readiness") return json(res, 200, summarizeReadiness({
        asr: asrAdapters.getPublicConfig(), tts: ttsAdapters.getPublicConfig(),
        demoProcedureAvailable: procedureRegistry.procedures.some(p => p.guidance_mode === "PROJECT_DEMO" || p.sop_status === "APPROVED"),
      }));
      if (req.method === "GET" && route === "/api/voice/config") return json(res, 200, {
        ...voiceAdapters.getPublicConfig(), asr: asrAdapters.getPublicConfig(), tts: ttsAdapters.getPublicConfig(),
      });
      if (req.method === "GET" && route === "/api/capabilities") return json(res, 200, {
        experiment_count: experimentRegistry.experiments.length,
        demo_procedure_count: procedureRegistry.procedures.filter((p) => p.guidance_mode === "PROJECT_DEMO").length,
        review_draft_count: procedureRegistry.drafts.length,
        review_draft_step_count: procedureRegistry.drafts.reduce((n, p) => n + p.steps.length, 0),
        review_draft_exception_count: procedureRegistry.drafts.reduce((n, p) => n + p.exception_routes.length, 0),
        approved_procedure_count: procedureRegistry.procedures.filter((p) => p.sop_status === "APPROVED").length,
        core_question_count: orchestrator.knowledgeStatus().available ? knowledgeRetriever.records.filter((r) => r.questions?.length && r.direct_answer_allowed && !r.collection).length : null,
        expanded_question_count: orchestrator.knowledgeStatus().available ? knowledgeRetriever.records.filter((r) => r.questions?.length && r.direct_answer_allowed && r.collection === "EXPANDED_PUBLIC_KNOWLEDGE").length : null,
        rice_update_question_count: orchestrator.knowledgeStatus().available ? knowledgeRetriever.records.filter((r) => r.questions?.length && r.direct_answer_allowed && r.collection === "RICE_DOCUMENT_UPDATE_2026_10").length : null,
        curated_question_count: orchestrator.knowledgeStatus().available ? knowledgeRetriever.records.filter((r) => r.questions?.length && r.direct_answer_allowed).length : null,
        public_source_count: orchestrator.knowledgeStatus().available ? [...knowledgeRetriever.sources.values()].filter((s) => s.url || s.public_record).length : null,
        knowledge_retrieval: { ...orchestrator.knowledgeStatus(), call_mode: "REQUIRED_FOR_KNOWLEDGE_ANSWERS" },
        prompt_revision: behaviorPolicy.prompt_revision,
        behavior_policy_version: behaviorPolicy.version, application_version: applicationVersion,
        voice_only: true, device_connected: false, flight_ready: false, general_llm_connected: false,
        knowledge_understanding: orchestrator.semanticAdapter.getPublicConfig(),
        exception_categories: [...ROUTES.map((route) => route.id), "PARAMETER_DEVIATION", "UNKNOWN"],
        detailed_demo_step_count: procedureRegistry.procedures.reduce((sum, p) => sum + p.steps.length, 0),
        deployment_mode: config.production ? "RESTRICTED_DEMO" : "LOCAL_DEMO",
        session_storage: sessions.repository ? "SQLITE" : "BOUNDED_PROCESS_MEMORY",
        session_ttl_seconds: sessions.repository ? null : sessions.ttl / 1000,
        restart_recovery: Boolean(sessions.repository), archive_history: Boolean(sessions.repository),
        record_export: true, task_change_confirmation: true, voice_turn_deduplication: true,
      });
      if (req.method === "GET" && route === "/api/experiments") return json(res, 200, {
        registry_version: experimentRegistry.config.registry_version, experiments: experimentRegistry.list(),
      });
      if (req.method === "GET" && route === "/api/procedures") return json(res, 200, {
        schema_version: procedureRegistry.config.schema_version,
        procedures: procedureRegistry.list().map((p) => ({ ...p, steps: procedureRegistry.getForExperiment(p.experiment_id).steps
          .map((s) => ({ step_id: s.step_id, name: s.name, sequence: s.sequence })) })),
        guidance_ready: procedureRegistry.procedures.some((p) => p.sop_status === "APPROVED"),
        demo_guidance_ready: procedureRegistry.procedures.some((p) => p.guidance_mode === "PROJECT_DEMO"),
        review_drafts: procedureRegistry.listDrafts(),
      });
      if (req.method === "GET" && route === "/api/knowledge/search") return json(res, 200, {
        query: (url.searchParams.get("q") || "").slice(0, 2000),
        ...await orchestrator.inspectKnowledge((url.searchParams.get("q") || "").slice(0, 2000), Number(url.searchParams.get("limit") || 5)),
        policy: "公开研究不能替代任务级审核SOP。",
      });
      if (req.method === "POST" && route === "/api/voice/turn") {
        const payload = await readJson(req);
        if (typeof payload.session_id !== "string" || typeof payload.recognized_text !== "string"
          || !payload.recognized_text.trim() || payload.recognized_text.length > 2000) throw failure("VOICE_TURN_INVALID");
        if (payload.request_id !== undefined && (typeof payload.request_id !== "string"
          || !/^[a-zA-Z0-9_-]{16,80}$/u.test(payload.request_id))) throw failure("TURN_ID_INVALID");
        if (payload.expected_revision !== undefined && (!Number.isSafeInteger(payload.expected_revision)
          || payload.expected_revision < 0 || !payload.request_id)) throw failure("TURN_REVISION_INVALID");
        const storedEntry = sessions.get(payload.session_id, owner);
        const currentSession = storedEntry.session;
        const currentProcedure = procedureRegistry.getForExperiment(currentSession.experiment_id);
        const canRepeat = !currentSession.procedure_id || currentSession.procedure_version === currentProcedure?.version;
        if (!canRepeat && payload.request_id && storedEntry.receipts.has(payload.request_id)) throw failure("PROCEDURE_VERSION_CHANGED", 409);
        const intent = classifyVoiceIntent(payload.recognized_text);
        const result = await sessions.turn(payload.session_id, owner, (session, previousReply) => orchestrator.handleVoiceTurn({
          session, recognized_text: payload.recognized_text,
          conversation_context: previousReply?.conversation_context || null,
          record_history: intent === "RECORD_HISTORY" && sessions.repository ? sessions.repository.history(owner) : null,
        }), { requestId: payload.request_id, expectedRevision: payload.expected_revision, text: payload.recognized_text,
          repeatLast: intent === "REPEAT" && canRepeat });
        return json(res, 200, result);
      }
      if (req.method === "POST" && route === "/api/asr/transcribe") {
        const result = await speechWork(async () => {
          const audio = await readBody(req, 15 * 1024 * 1024);
          if (!audio.length) throw failure("AUDIO_REQUIRED");
          return asrAdapters.transcribe({ audioBuffer: audio,
            contentType: req.headers["content-type"], language: req.headers["x-asr-language"] });
        });
        return json(res, result.ok ? 200 : 503, result.ok ? { ok: true, text: result.text } : speechFailure(result));
      }
      if (req.method === "POST" && route === "/api/tts/synthesize") {
        const payload = await readJson(req);
        if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 4096) throw failure("TTS_TEXT_INVALID");
        const result = await speechWork(() => ttsAdapters.synthesize({ text: payload.text }));
        if (!result.ok) return json(res, 503, speechFailure(result));
        res.writeHead(200, { "Content-Type": result.contentType || "audio/mpeg", "Content-Length": result.buffer.length });
        res.end(result.buffer); return;
      }
      throw failure("NOT_FOUND", 404);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const status = error.status || 500;
      req.resume();
      if (status === 429) res.setHeader("Retry-After", "60");
      if (status === 413 || status === 408) res.setHeader("Connection", "close");
      json(res, status, { ok: false, error: error.status ? error.message : "INTERNAL_ERROR" });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  return { server, sessions, access, config };
}

module.exports = { createApp };
