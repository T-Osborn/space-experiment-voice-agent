(function (root) {
  let experiments = [];
  let procedures = [];
  let reviewDrafts = [];
  const element = (id) => document.querySelector(`#${id}`);
  const set = (id, value) => { const node = element(id); if (node) node.textContent = String(value); };

  function phase(value) {
    const names = { READY: "等待语音", LISTENING: "正在聆听", PROCESSING: "核对中", SPEAKING: "正在播报", PENDING: "等待接入", ERROR: "需检查" };
    set("voicePhase", names[value] || names.READY);
    const orbit = element("voiceOrbit"); if (orbit) orbit.dataset.phase = value;
  }
  function load({ capabilities, experimentData, procedureData, voice }) {
    set("versionLabel", capabilities.application_version ? `v${capabilities.application_version} · 软件交互演示` : "服务未返回版本信息");
    set("serviceState", "本机服务已连接");
    set("navExperimentCount", capabilities.experiment_count ?? "—");
    set("voiceIdentity", voice.tts?.target_voice || "未登记音色名称");
    experiments = experimentData.experiments || []; procedures = procedureData.procedures || [];
    reviewDrafts = procedureData.review_drafts || [];
    for (const [id, key] of [["experimentCount", "experiment_count"], ["demoCount", "demo_procedure_count"], ["questionCount", "curated_question_count"], ["sourceCount", "public_source_count"]]) set(id, capabilities[key] ?? (id === "questionCount" ? capabilities.core_question_count : undefined) ?? "—");
    set("deploymentMode", capabilities.deployment_mode === "RESTRICTED_DEMO" ? "受限演示" : "本机演示");
    set("recordStorage", capabilities.restart_recovery
      ? "任务记录自动保存在服务端。同一浏览器可在重启后找回任务；清除浏览器数据会影响自动恢复。说“查看历史记录”可下载归档。"
      : "当前为临时内存模式。服务重启或会话到期会清空记录，请说“保存记录”并确认下载成功。");
    set("asrStatus", voice.asr?.configured ? "已配置·待实测" : "尚未配置");
    set("ttsStatus", voice.tts?.configured ? "已配置·待实测" : voice.tts?.browser_playback_allowed ? "浏览器音色" : "等待所选音色");
    set("understandingStatus", capabilities.knowledge_retrieval?.available === false
      ? "知识问答：题库当前不可用，请检查加载状态"
      : "知识问答：本地题库可用，可以直接提问");
    element("asrDot")?.classList.toggle("ready", voice.asr?.configured === true);
    element("ttsDot")?.classList.toggle("ready", voice.tts?.configured === true);
    const directory = element("experimentDirectory");
    if (directory) {
      directory.replaceChildren();
      for (const experiment of experiments) {
        const demo = procedures.some((procedure) => procedure.experiment_id === experiment.experiment_id && procedure.guidance_mode === "PROJECT_DEMO");
        const draft = reviewDrafts.find((item) => item.experiment_id === experiment.experiment_id);
        const card = document.createElement("article"); card.className = `experiment-card${demo ? " has-demo" : ""}`;
        const name = document.createElement("h3"); name.textContent = experiment.display_name;
        const status = document.createElement("p"); status.textContent = demo ? "演示流程 · 待任务审核"
          : draft ? `待审草案 · ${draft.step_count}个核对节点 / ${draft.exception_route_count}条异常分支 · 未解锁` : "目录已登记 · 流程待补齐";
        card.append(name, status); directory.append(card);
      }
    }
    phase(voice.asr?.configured ? "READY" : "PENDING");
  }
  function context(session) {
    const experiment = experiments.find((item) => item.experiment_id === session.experiment_id);
    const procedure = procedures.find((item) => item.procedure_id === session.procedure_id);
    return { experiment, procedure: procedure ? { ...procedure,
      current_step_name: procedure.steps?.find((step) => step.step_id === session.current_step)?.name,
    } : null };
  }
  function update(result) {
    const { session } = result;
    const progress = result.progress;
    set("stepDecision", progress?.decision || (session.procedure_id ? "当前服务未返回详细进度" : "尚未开始步骤引导"));
    set("confirmedInputs", progress?.confirmed?.map(record => `${record.name}：${record.display_values}`).join("。") || "尚无已确认参数");
    set("reportedInputs", "本步报告：" + (progress?.reported?.map(item => `${item.label}：${item.display_value}`).join("；") || "尚无"));
    set("pendingInputs", "待补充：" + (progress?.missing?.map(item => item.label).join("；") || (progress ? "字段已齐全，按当前判定处理" : "选择实验后显示")));
    set("nextAction", "下一步：" + (progress?.next_action || "可直接提问，或选择实验流程"));
    renderWorkbench(result);
    if (["FAILED", "UNCONNECTED", "UNAVAILABLE"].includes(result.knowledge?.retrieval_status)) {
      set("understandingStatus", result.knowledge.retrieval_status === "FAILED" ? "知识问答：本次检索失败，可稍后重试" : "知识问答：题库当前不可用");
    } else if (["MATCHED", "NO_MATCH"].includes(result.knowledge?.retrieval_status)) {
      set("understandingStatus", result.knowledge.retrieval_status === "MATCHED" ? "知识问答：已检索到有出处的资料" : "知识问答：检索完成，本题暂无明确答案");
    }
    const procedure = procedures.find((item) => item.procedure_id === session.procedure_id);
    const draft = reviewDrafts.find((item) => item.experiment_id === session.experiment_id);
    set("procedureScope", procedure ? "项目演示配置：尚未获得任务级审核。"
      : draft ? "已有流程与异常分支草案，专家尚未签审，不能启动。可通过语音查询草案范围。"
      : session.experiment_id ? "当前实验没有加载步骤流程。可查询已登记资料。" : "请在语音接入后说出实验名称。水稻仅用于最终展示。");
    const completed = new Set(session.completed_steps || []);
    set("progressLabel", procedure ? `已确认 ${completed.size} / ${procedure.step_count} 步${session.event_log_truncated ? " · 历史记录已截断" : ""}` : "尚未开始");
    const timeline = element("stepTimeline"); if (!timeline) return;
    timeline.replaceChildren();
    if (!procedure) {
      const empty = document.createElement("li"); empty.className = "timeline-empty"; empty.textContent = "选择已加载流程的实验后显示步骤。"; timeline.append(empty); return;
    }
    for (const step of procedure.steps || []) {
      const row = document.createElement("li"); row.textContent = step.name;
      if (completed.has(step.step_id)) row.className = "complete";
      else if (step.step_id === session.current_step) { row.className = "active"; row.setAttribute("aria-current", "step"); }
      timeline.append(row);
    }
  }
  function heard(text) {
    set("recognizedText", text || "尚无本轮语音输入");
  }

  // View rendering only: no task commands, speech requests or mutations of result/session.
  function renderWorkbench(result) {
    const session = result.session || {};
    const progress = result.progress;
    const paused = progress?.paused === true || ["PAUSED", "EXCEPTION_REPORTED"].includes(session.status);
    const pending = !paused && session.step_state === "WAITING_STEP_CONFIRMATION";
    const completed = session.status === "COMPLETED";
    const state = paused ? session.status === "EXCEPTION_REPORTED" ? "EXCEPTION_REPORTED" : "PAUSED"
      : pending ? "WAITING_STEP_CONFIRMATION" : session.status || "IDLE";
    if (document.body) document.body.dataset.taskState = state;
    set("taskStateLabel", progress?.decision || ({IDLE:"未开始",CONTEXT_SELECTED:"等待开始",COMPLETED:"交互核对完成"}[session.status] || "等待报告"));
    set("confirmationStatus", paused ? "流程保持暂停" : completed ? "末步已确认 · 演示结束" : pending ? "等待读回后的独立确认" : "等待补充口述字段");
    set("readbackInstruction", paused ? session.pause_reason === "OPERATOR" ? "操作者暂停，当前数据保留。按助手提示恢复后再核对。"
      : "流程保持暂停。普通“确认”或“继续”不会解除异常或规则冲突暂停。"
      : completed ? "完成的是口述交互核对，不代表样品质量或实验结果获准。"
        : pending ? "请核对完整读回内容，再在独立一轮语音中说“确认无误”。" : "先补齐缺失字段；助手读回后，再独立语音确认。");
    set("stepNumber", progress ? `STEP ${String(progress.step_number).padStart(2,"0")} / ${String(progress.total_steps).padStart(2,"0")}` : "等待选择");
    set("stepCounter", progress ? `${String(progress.total_steps).padStart(2,"0")} STEPS` : "—");
    const fill = element("progressFill");
    if (fill?.style) fill.style.width = progress?.total_steps ? `${Math.min(100, Math.max(0, (progress.confirmed_steps || 0) / progress.total_steps * 100))}%` : "0%";
    if (result.speech_text) set("assistantReply", result.speech_text);
    else if (result.response_type === "SESSION_LOADED") {
      set("assistantReply", progress ? `已恢复任务记录。${progress.next_action}。` : "可以先说“语音帮助”，或通过语音选择实验。");
    }
    const banner = element("exceptionBanner");
    if (banner) banner.hidden = !paused;
    set("pauseTitle", /版本不一致/u.test(progress?.decision || "") ? "流程版本不一致 旧记录已保留" : session.pause_reason === "RULE_CONFLICT" ? "资料存在冲突 暂停判定"
      : session.pause_reason === "OPERATOR" ? "操作者已暂停 当前进度保留" : "异常暂停 等待适用恢复依据");
    set("pauseMessage", session.last_exception
      ? `${session.last_exception.category_name || "待评估异常"}。${progress?.next_action || "流程保持暂停"}。`
      : progress?.next_action || "不会通过普通确认自动解除暂停。");

    const fields = element("reportFields");
    if (fields) {
      fields.replaceChildren();
      const values = [
        ...(progress?.reported || []).map(field => ({...field, reported:true})),
        ...(progress?.missing || []).map(field => ({...field, reported:false})),
      ];
      for (const field of values) {
        const row = document.createElement("li"); row.className = field.reported ? "reported" : "missing";
        const label = document.createElement("span"); label.className = "field-name"; label.textContent = field.label;
        const value = document.createElement("strong"); value.className = "field-value"; value.textContent = field.reported ? field.display_value : "未报告";
        const status = document.createElement("span"); status.className = "field-state";
        status.textContent = !field.reported ? "待补充" : completed ? "已确认 · 口述" : pending ? "待独立确认" : "已口述 · 未确认";
        row.append(label, value, status); fields.append(row);
      }
      if (!values.length) {
        const empty = document.createElement("li"); empty.className = "review-empty";
        empty.textContent = progress ? "本步没有待展示的口述字段，请按助手提示核对。" : "通过语音选择实验并开始后，显示待报告字段。"; fields.append(empty);
      }
    }
    renderException(session);
    renderEvents(session);
    // Task replies also carry a NOT_REQUESTED knowledge envelope. Keep the last
    // actual query visible instead of mislabelling a field report as a lookup.
    if (result.knowledge?.retrieval_status && result.knowledge.retrieval_status !== "NOT_REQUESTED") renderSources(result);
  }

  function renderException(session) {
    const disclosure = element("exceptionReadback");
    if (disclosure) disclosure.hidden = !session.last_exception && !session.pending_resume_basis;
    const container = element("exceptionDetails"); if (!container) return;
    container.replaceChildren();
    const info = session.last_exception;
    for (const [name, value] of [
      ["异常现象原话", info?.description], ["受影响对象", info?.details?.affected_item],
      ["补充现象", info?.details?.phenomenon], ["已采取处置", info?.details?.actions_taken],
      ["待核对恢复依据", session.pending_resume_basis?.query],
    ]) {
      const p = document.createElement("p"); p.textContent = `${name}：${value || "未报告"}`; container.append(p);
    }
    const caveat = document.createElement("p"); caveat.textContent = "以上为操作者口述，未独立验证地面授权。"; container.append(caveat);
  }

  function renderEvents(session) {
    const list = element("taskEvents"); if (!list) return;
    list.replaceChildren();
    const labels = {PROCEDURE_STARTED:"开始演示核对",OPERATOR_FEEDBACK:"收到口述报告",STEP_CONFIRMED:"步骤已独立确认",
      GUIDANCE_PAUSED:"暂停引导",GUIDANCE_RESUMED:"恢复原步骤",EXCEPTION_REPORTED:"记录异常",EXCEPTION_DETAILS_REPORTED:"补充异常口述",
      OPERATOR_REPORTED_RESUME_BASIS:"记录恢复依据口述 未独立验证",PAUSED_FEEDBACK:"暂停期间收到反馈",STEP_RECHECK_STARTED:"重新核对本步"};
    const events = (session.event_log || []).slice(-6);
    for (const event of events) {
      const item = document.createElement("li");
      item.textContent = `${event.timestamp_utc || "未记录时间"} · ${labels[event.event_type] || event.event_type || "任务事件"}`; list.append(item);
    }
    if (!events.length) { const empty = document.createElement("li"); empty.textContent = "尚无事件记录"; list.append(empty); }
  }

  function renderSources(result) {
    const knowledge = result.knowledge;
    set("knowledgeAnswer", result.speech_text || "尚无本次知识回复");
    const answer = element("knowledgeAnswer"); if (answer) answer.hidden = false;
    set("knowledgeQuestion", "最近一次知识查询：" + (knowledge.query || "未记录问题"));
    const names = {MATCHED:"已登记资料",NO_MATCH:"暂无明确依据",FAILED:"检索失败",UNAVAILABLE:"题库不可用",UNCONNECTED:"检索未连接",NOT_REQUIRED:"需要任务依据"};
    set("sourceState", result.response_type === "SOURCE_CONFLICT" ? "资料差异 待核对" : names[knowledge.retrieval_status] || "等待澄清");
    const container = element("sourceCards"); if (!container) return;
    container.replaceChildren();
    const record = knowledge.matched_records?.[0];
    const sources = record?.sources || [];
    for (const source of sources) {
      const card = document.createElement("article"); card.className = "source-card";
      const title = document.createElement("h3");
      if (/^https:\/\//u.test(source.url || "")) {
        const link = document.createElement("a"); link.textContent = source.title; link.href = source.url;
        link.target = "_blank"; link.rel = "noopener noreferrer"; title.append(link);
      } else title.textContent = source.title || "项目资料";
      const id = document.createElement("p"); id.textContent = `登记编号：${source.id}${source.doi ? " · DOI："+source.doi : ""}`;
      const scope = document.createElement("p"); scope.textContent = `定位：${record.evidence_locator || "未登记"}。仅用于知识背景或差异说明，不授权操作。`;
      card.append(title, id, scope); container.append(card);
    }
    if (!sources.length) {
      const empty = document.createElement("p"); empty.className = "source-empty";
      empty.textContent = knowledge.retrieval_status === "NO_MATCH" ? "检索已完成，本题未找到明确依据；不会补造出处。"
        : ["FAILED","UNCONNECTED","UNAVAILABLE"].includes(knowledge.retrieval_status) ? "当前不能确认题库是否有答案，不能将检索故障当作无答案。"
          : "当前问题需澄清或任务级依据，未据公开资料生成操作参数。";
      container.append(empty);
    }
  }
  root.VoiceDashboard = { phase, load, context, update, heard };
})(window);
