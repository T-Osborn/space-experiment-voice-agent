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
    experiments = experimentData.experiments || []; procedures = procedureData.procedures || [];
    reviewDrafts = procedureData.review_drafts || [];
    for (const [id, key] of [["experimentCount", "experiment_count"], ["demoCount", "demo_procedure_count"], ["questionCount", "curated_question_count"], ["sourceCount", "public_source_count"]]) set(id, capabilities[key] ?? (id === "questionCount" ? capabilities.core_question_count : undefined) ?? "—");
    set("deploymentMode", capabilities.deployment_mode === "RESTRICTED_DEMO" ? "受限演示" : "本机演示");
    set("recordStorage", capabilities.restart_recovery
      ? "任务记录自动保存在服务端。同一浏览器可在重启后找回任务；清除浏览器数据会影响自动恢复。说“查看历史记录”可下载归档。"
      : "当前为临时内存模式。服务重启或会话到期会清空记录，请说“保存记录”并确认下载成功。");
    set("asrStatus", voice.asr?.configured ? "已配置·待实测" : "尚未配置");
    set("ttsStatus", voice.tts?.configured ? "已配置·待实测" : voice.tts?.browser_playback_allowed ? "浏览器音色" : "等待所选音色");
    set("understandingStatus", capabilities.knowledge_understanding?.configured
      ? "知识理解：本地检索 + 只读语义匹配 · 待实测"
      : "知识理解：本地检索 · 语义模型暂未配置");
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
  root.VoiceDashboard = { phase, load, context, update };
})(window);
