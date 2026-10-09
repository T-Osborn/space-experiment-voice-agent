const fs = require("node:fs");
const path = require("node:path");
const { KnowledgeRetriever, knowledgeBoundary } = require("./knowledge-retriever");
const { ExperimentRegistry } = require("./experiment-registry");
const { ProcedureRegistry } = require("./procedure-registry");
const { ProcedureEngine } = require("./procedure-engine");
const { classifyVoiceIntent } = require("./voice-intents");
const { SemanticAdapter } = require("./semantic-adapter");
const { DialogueMemory } = require("./dialogue-memory");
const { randomUUID } = require("node:crypto");
const { exportTask, taskHelp } = require("./task-lifecycle");

const PERSONA_PATH = path.join(__dirname, "..", "config", "persona.json");

class AgentOrchestrator {
  constructor({ asr, tts, semanticAdapter, dialogueMemory, knowledgeRetriever, experimentRegistry, procedureRegistry, procedureEngine } = {}) {
    this.asr = asr;
    this.semanticAdapter = semanticAdapter || new SemanticAdapter();
    this.dialogueMemory = dialogueMemory || new DialogueMemory();
    this.tts = tts;
    this.knowledgeRetriever = knowledgeRetriever || new KnowledgeRetriever();
    this.experimentRegistry = experimentRegistry || new ExperimentRegistry();
    this.procedureRegistry = procedureRegistry || new ProcedureRegistry();
    this.procedureEngine = procedureEngine || new ProcedureEngine();
    this.persona = JSON.parse(fs.readFileSync(PERSONA_PATH, "utf8"));
  }

  createSession() {
    return {
      session_id: `session_${randomUUID()}`,
      experiment_id: null,
      status: "IDLE",
      current_step: null,
    };
  }

  async handleVoiceTurn({ session, recognized_text, record_history = null }) {
    if (!session || typeof session !== "object") {
      throw new Error("SESSION_REQUIRED");
    }

    if (typeof recognized_text !== "string" || recognized_text.trim() === "") {
      throw new Error("RECOGNIZED_TEXT_REQUIRED");
    }

    const query = recognized_text.trim();
    let intent = classifyVoiceIntent(query);
    const currentRouting = this.experimentRegistry.route("", session, { allowSwitch: false });
    if (intent === "HELP") return this.buildResponse({ session, routing: currentRouting, query,
      response_type: "VOICE_HELP", speech_text: taskHelp(session) });
    if (intent === "RECORD_HISTORY") {
      const records = (record_history || []).map(record => ({ ...record,
        experiment_name: this.experimentRegistry.list().find(item => item.experiment_id === record.experiment_id)?.display_name || "未选择实验",
      }));
      return { ...this.buildResponse({ session, routing: currentRouting, query, response_type: "RECORD_HISTORY",
        speech_text: record_history === null ? "当前服务使用临时内存，尚未启用历史归档。可以说保存记录并下载文件。"
          : records.length ? `找到近期${records.length}份已归档记录，下载链接已显示在页面。最新一份属于${records[0].experiment_name}，记录中已确认${records[0].completed_steps}步。当前任务没有改变。`
          : "当前浏览器还没有已归档记录。当前任务自动保存；说保存记录、切换任务或重新开始时会另外生成归档。",
      }), record_history: records };
    }
    if (intent === "EXPORT_RECORD") return { ...this.buildResponse({ session, routing: currentRouting, query,
      response_type: "RECORD_EXPORT", speech_text: "记录文件已生成，已请求浏览器下载。请确认文件已保存；如果下载被阻止，可使用页面的记录下载链接。保存记录不会确认数据或推进步骤。" }),
      record_export: exportTask(session, this.procedureRegistry) };
    if (intent === "CANCEL_TASK_CHANGE") return this.buildResponse({ session: { ...session, pending_task_change: null },
      routing: currentRouting, query, response_type: "TASK_CHANGE_CANCELLED", speech_text: "已取消任务变更，原实验及记录保留。" });
    if (intent === "CONFIRM_TASK_CHANGE") {
      const change = session.pending_task_change;
      const expected = change?.kind === "RESTART" ? "确认重新开始" : "确认切换";
      if (!change || query.replace(/[\s，。！？,.!?]/gu, "").replace(/^请/u, "") !== expected) {
        return this.buildResponse({ session, routing: currentRouting, query, response_type: "TASK_CHANGE_REQUIRED",
          speech_text: "没有与这句话匹配的任务变更。当前步骤和记录没有改变。" });
      }
      const record = exportTask(session, this.procedureRegistry);
      const clean = { session_id: session.session_id, revision: session.revision,
        experiment_id: change.kind === "RESTART" ? session.experiment_id : null,
        status: change.kind === "RESTART" ? "CONTEXT_SELECTED" : "IDLE", current_step: null };
      this.dialogueMemory.clear(session.session_id);
      const result = await this.handleVoiceTurn({ session: clean, recognized_text: change.query });
      return { ...result, record_export: record,
        speech_text: `原任务记录已生成下载文件，请确认保存。${result.speech_text}` };
    }
    if (intent === "RESTART_TASK") {
      if (!session.experiment_id) return this.buildResponse({ session, routing: currentRouting, query,
        response_type: "EXPERIMENT_REQUIRED", speech_text: "请先说出要选择的实验名称。" });
      session = { ...session, pending_task_change: { kind: "RESTART", query: "开始流程" } };
      return this.buildResponse({ session, routing: currentRouting, query, response_type: "TASK_CHANGE_REQUIRED",
        speech_text: "重新开始会建立新的一次任务，并生成原记录的下载文件。请说确认重新开始，或取消重新开始。普通的确认无误不会执行此变更。" });
    }
    // Known spoken questions still remain queries when ASR omits punctuation.
    if (intent === "FEEDBACK" && this.knowledgeRetriever.isKnownQuestion?.(query)) intent = "KNOWLEDGE";
    // Read-only questions preserve the pending change; a new report or correction invalidates it.
    if (session.pending_task_change && !["STATUS", "LIST_EXPERIMENTS", "SUMMARY", "REPEAT", "STEP_HELP", "KNOWLEDGE", "REVIEW_DRAFT"].includes(intent)) {
      session = { ...session, pending_task_change: null };
    }
    const routing = this.experimentRegistry.route(query, session, {
      allowSwitch: ["SELECT", "START"].includes(intent) || (!session.experiment_id && intent === "FEEDBACK"),
    });
    if (session.procedure_id && ((routing.switched && ["SELECT", "START"].includes(intent))
      || (intent === "START" && session.status === "COMPLETED"))) {
      const restart = !routing.switched;
      return this.buildResponse({ session: { ...session, pending_task_change: { kind: restart ? "RESTART" : "SWITCH", query } },
        routing: currentRouting, query, response_type: "TASK_CHANGE_REQUIRED",
        speech_text: `${restart ? "重新开始" : `切换到${routing.experiment.display_name}`}会建立新任务，并生成原记录的下载文件。请说${restart ? "确认重新开始" : "确认切换"}，或说取消任务变更。当前实验尚未改变。` });
    }
    if (intent === "REVIEW_DRAFT") {
      const experiment = this.experimentRegistry.resolve(query) || routing.experiment;
      const draft = this.procedureRegistry.getDraftForExperiment?.(experiment?.experiment_id);
      return this.buildResponse({ session, routing, query, response_type: "PROCEDURE_DRAFT_OVERVIEW",
        speech_text: draft ? `${draft.display_name}尚未经过专家审核，不能用于实际操作。${draft.scope_note}草案有${draft.steps.length}个记录节点：${draft.steps.map(s => s.name).join("；")}。有${draft.exception_routes.length}条待审异常分支。仍需任务SOP、逐项参数、技术处置与恢复规程及正式签审。查看草案不会改变当前任务。`
          : "该实验尚无待审流程草案。请先选择实验或明确要查看的实验名称；不会改变当前步骤。" });
    }
    if (intent === "LIST_EXPERIMENTS") {
      const experiments = this.experimentRegistry.list();
      const procedures = this.procedureRegistry.list();
      const drafts = this.procedureRegistry.listDrafts?.() || [];
      return this.buildResponse({
        session, routing, query,
        response_type: "EXPERIMENT_LIST",
        speech_text: `目前登记了${experiments.length}个实验，已加载${procedures.length}个演示或操作流程配置，另有${drafts.length}套待审核草案，草案不能启动实验。已加载流程包括：${procedures.map((item) => experiments.find((experiment) => experiment.experiment_id === item.experiment_id)?.display_name).filter(Boolean).join("；") || "暂无"}。其他目录项需要补齐或审核。请说出要查询或选择的实验名称。`,
      });
    }
    if (routing.kind === "UNREGISTERED") {
      return this.buildResponse({
        session,
        response_type: "EXPERIMENT_UNREGISTERED",
        speech_text: "当前没有登记与这条语音对应的实验配置。请先由地面专家登记实验名称、任务级SOP和异常处置规则，再开始语音流程引导。",
        routing,
        query,
      });
    }

    session = routing.session;
    if (routing.switched) this.dialogueMemory.clear(session.session_id);
    if (routing.kind === "MATCHED" && intent === "SELECT") {
      const procedure = this.procedureRegistry.getForExperiment(routing.experiment.experiment_id);
      const draft = this.procedureRegistry.getDraftForExperiment?.(routing.experiment.experiment_id);
      const availability = procedure
        ? (procedure.guidance_mode === "PROJECT_DEMO" ? "已加载项目演示流程，可以说开始流程。" : "已加载流程配置，可以说开始流程。")
        : draft ? "已有待专家审核的流程草案，不能启动实验。可以说查看流程草案。" : "当前没有加载步骤流程，可以查询已有资料。";
      return this.buildResponse({
        session,
        response_type: "EXPERIMENT_SELECTED",
        speech_text: `已选择${routing.experiment.display_name}。${availability}`,
        routing,
        query,
      });
    }

    const activeGuidance = session.procedure_id
      && ["GUIDING", "PAUSED", "EXCEPTION_REPORTED", "COMPLETED"].includes(session.status);
    if (["STATUS", "REPEAT", "SUMMARY", "STEP_HELP", "RECHECK_STEP"].includes(intent) && !activeGuidance) {
      return this.buildResponse({
        session, routing, query, response_type: "GUIDANCE_STATUS",
        speech_text: routing.experiment
          ? `当前选择的是${routing.experiment.display_name}，尚未开始步骤引导。`
          : "尚未选择实验。请先说出实验名称。",
      });
    }
    if (intent !== "KNOWLEDGE" && (this.procedureEngine.isGuidanceRequest(query) || activeGuidance)) {
      if (!routing.experiment) {
        return this.buildResponse({
          session,
          response_type: "EXPERIMENT_REQUIRED",
          speech_text: "开始流程引导前，请先说明要进行哪一个已登记实验。",
          routing,
          query,
        });
      }

      const procedure = this.procedureRegistry.getForExperiment(routing.experiment.experiment_id);
      const reviewDraft = this.procedureRegistry.getDraftForExperiment?.(routing.experiment.experiment_id);
      if (!procedure && reviewDraft) return this.buildResponse({ session, routing, query,
        response_type: "PROCEDURE_REVIEW_REQUIRED",
        speech_text: "已准备该实验的流程草案与异常分支，但任务操作细节和专家审核未完成，不能启动或恢复实验引导。说专家已同意也不会解锁。可以说查看流程草案。" });
      if (intent === "START" && /(真实|正式在轨|实际飞行)/u.test(query)
        && procedure?.sop_status !== "APPROVED") return this.buildResponse({
        session, routing, query, procedure, response_type: "PROCEDURE_REVIEW_REQUIRED",
        speech_text: "当前没有该任务的已审核飞行SOP，不能开始真实实验操作引导。只能演示交互核对，请先取得任务方审核的操作与异常规程。",
      });
      const guidance = session.procedure_id === procedure?.procedure_id && !(intent === "START" && session.status === "COMPLETED")
        ? this.procedureEngine.handleInput(session, procedure, query, intent)
        : this.procedureEngine.start(session, procedure);
      return this.buildResponse({
        session: guidance.session,
        speech_text: guidance.speech_text,
        response_type: guidance.response_type,
        routing,
        query,
        procedure: guidance.procedure || procedure,
      });
    }

    const resolvedQuery = this.dialogueMemory.resolve(session.session_id, query, this.knowledgeRetriever.records);
    let results = this.knowledgeRetriever.search(resolvedQuery, 3);
    let semanticDecision = null;
    if (!results.length && intent === "KNOWLEDGE" && !knowledgeBoundary(query) && !knowledgeBoundary(resolvedQuery)) {
      const catalog = this.knowledgeRetriever.semanticCatalog(resolvedQuery);
      semanticDecision = await this.semanticAdapter.select({ query: resolvedQuery, catalog });
      if (semanticDecision?.decision === "MATCH") {
        const record = this.knowledgeRetriever.getRecord(semanticDecision.record_id);
        if (record && catalog.some((item) => item.record_id === record.record_id)
          && typeof semanticDecision.evidence_quote === "string" && semanticDecision.evidence_quote.length >= 2
          && resolvedQuery.includes(semanticDecision.evidence_quote)) {
          results = [{ ...record, score: 50, match_type: "MODEL_SELECTED_REGISTERED_RECORD" }];
        }
      }
    }
    const topResult = results[0] || null;
    const response = semanticDecision?.decision === "CLARIFY"
      ? { response_type: "KNOWLEDGE_CLARIFICATION", speech_text: "题意尚不明确。请说明具体研究、任务年份，以及要查询的主题。不会据此改变实验记录或步骤。" }
      : this.composeKnowledgeResponse({ query, results });
    if (["KNOWLEDGE_ANSWER", "SOURCE_CONFLICT"].includes(response.response_type)) {
      const record = this.knowledgeRetriever.records.find((item) => item.record_id === topResult.record_id);
      this.dialogueMemory.remember(session.session_id, record);
    }

    return this.buildResponse({
      session,
      speech_text: response.speech_text,
      response_type: response.response_type,
      routing,
      query,
      knowledge: {
        query,
        resolved_query: resolvedQuery,
        semantic_mode: results.some((item) => item.match_type === "MODEL_SELECTED_REGISTERED_RECORD") ? "MODEL_ROUTED" : "LOCAL",
        matched_records: results.map((item) => ({
          record_id: item.record_id,
          title: item.title,
          evidence_level: item.evidence_level,
          execution_allowed: item.execution_allowed,
          direct_answer_allowed: item.direct_answer_allowed,
          match_type: item.match_type,
          evidence_locator: item.evidence_locator,
          source_checked_on: item.source_checked_on,
          sources: item.sources,
        })),
        top_record_id: topResult?.record_id || null,
      },
    });
  }

  buildResponse({ session, speech_text, response_type, routing, query, procedure = null, knowledge = null }) {
    if (!procedure && session.procedure_id) {
      const current = this.procedureRegistry.getForExperiment(session.experiment_id);
      if (current?.procedure_id === session.procedure_id) procedure = current;
    }
    const currentProcedureStep = procedure?.steps?.find((step) => step.step_id === session.current_step) || null;
    return {
      session,
      speech_text,
      response_type,
      tts_audio_url: null,
      experiment: routing.experiment
        ? {
            experiment_id: routing.experiment.experiment_id,
            display_name: routing.experiment.display_name,
            sop_status: routing.experiment.sop_status,
            execution_policy: routing.experiment.execution_policy,
            switched: routing.switched,
          }
        : null,
      procedure: procedure
        ? {
            procedure_id: procedure.procedure_id,
            version: procedure.version,
            sop_status: procedure.sop_status,
            current_step: session.current_step,
            current_step_name: currentProcedureStep?.name || null,
            step_state: session.step_state || null,
          }
        : null,
      knowledge: knowledge || { query, matched_records: [], top_record_id: null },
      persona: {
        agent_name: this.persona.agent_name,
        language: this.persona.conversation_style.language,
        tts_ready: this.persona.conversation_style.tts_ready
      }
    };
  }

  composeKnowledgeResponse({ query, results }) {
    const boundary = knowledgeBoundary(query);
    if (boundary === "NO_TELEMETRY") {
      return {
        response_type: "KNOWLEDGE_NO_TELEMETRY",
        speech_text: "我没有连接实验设备，不能读取当前测量值。请口述仪表读数；已记录的数据可以通过‘读回数据’核对。口述记录不代表设备独立验证。",
      };
    }
    if (boundary === "TASK_SOP_REQUIRED") {
      return {
        response_type: "KNOWLEDGE_SOP_REQUIRED",
        speech_text: "这个问题需要本任务已审核的操作或异常处置规则。现有公开研究不能决定当前实验的设置、校准或安全放行条件。请核对任务SOP，必要时请求地面专家确认。",
      };
    }
    results = results.filter((item) => item.direct_answer_allowed === true
      && item.sources?.length && item.sources.some((source) => /^https:\/\//u.test(source.url || "")));
    if (results.length === 0) {
      return {
        response_type: "KNOWLEDGE_MISSING",
        speech_text: `${this.persona.fixed_responses.knowledge_missing} 当前问题：${query}。`,
      };
    }

    const top = results[0];
    if (top.match_type !== "EXACT_QUESTION" && results[1]?.score === top.score
      && results[1].record_type !== "source_conflict" && top.record_type !== "source_conflict") {
      return {
        response_type: "KNOWLEDGE_CLARIFICATION",
        speech_text: `问题可能涉及多个主题。请说明你要查询的是${top.title}，还是${results[1].title}。`,
      };
    }
    const source = top.sources[0];
    const sourceName = top.spoken_citation || source.title;

    if (top.record_type === "source_conflict") {
      return {
        response_type: "SOURCE_CONFLICT",
        speech_text: `检索到来源冲突。${top.answer} 当前不能据此生成实验操作或样品转移指令，请以任务级审核SOP和地面专家确认结果为准。来源：${sourceName}。`,
      };
    }

    return {
      response_type: "KNOWLEDGE_ANSWER",
      speech_text: `${top.answer} 参考来源：${sourceName}。${top.limitations || ""}`,
    };
  }
}

module.exports = { AgentOrchestrator };
