const { classifyVoiceIntent } = require("./voice-intents");
const { extractStepInputs } = require("./spoken-inputs");
const { createException, collectExceptionDetails, exceptionPrompt } = require("./exception-assistant");

class ProcedureEngine {
  isGuidanceRequest(query) {
    return ["START", "CONFIRM", "PAUSE", "RESUME", "EXCEPTION", "STATUS", "REPEAT", "SUMMARY", "STEP_HELP", "RECHECK_STEP"].includes(classifyVoiceIntent(query));
  }

  start(session, procedure) {
    if (procedure?.guidance_mode === "EXPERT_REVIEW_DRAFT" || procedure?.sop_status === "EXPERT_REVIEW_PENDING") {
      return this.response("PROCEDURE_REVIEW_REQUIRED", session, procedure,
        "该流程是待专家审核的草案，不能启动实验步骤。口述同意、开始或继续都不能替代任务规程和正式审核。可以查询草案范围与待补资料。");
    }
    if (!procedure || !procedure.steps?.length) {
      return {
        response_type: "PROCEDURE_UNAVAILABLE",
        session,
        speech_text: "当前实验还没有加载可用的语音流程，请先补齐并审核该实验的步骤配置。",
      };
    }
    const firstStep = procedure.steps[0];
    const nextSession = {
      ...session,
      status: "GUIDING",
      procedure_id: procedure.procedure_id,
      procedure_version: procedure.version || null,
      current_step: firstStep.step_id,
      step_state: "WAITING_INPUT",
      pending_confirmation: null,
      observations: {},
      step_observations: {},
      completed_steps: [],
      step_records: {},
      pause_reason: null,
      last_operator_feedback: null,
      last_exception: null,
      event_log: this.appendEvent(session.event_log, "PROCEDURE_STARTED", {
        procedure_id: procedure.procedure_id,
        step_id: firstStep.step_id,
      }),
    };
    return this.response("STEP_GUIDANCE", nextSession, procedure,
      (procedure.guidance_mode === "PROJECT_DEMO" ? "当前是项目演示核对，不是已审核飞行SOP。" : "") + this.buildStepPrompt(firstStep, nextSession));
  }

  response(response_type, session, procedure, speech_text) {
    return { response_type, session, procedure, speech_text };
  }

  handleInput(session, procedure, query, intent = classifyVoiceIntent(query)) {
    if (!procedure) return this.start(session, procedure);
    if (procedure.guidance_mode === "EXPERT_REVIEW_DRAFT" || procedure.sop_status === "EXPERT_REVIEW_PENDING") {
      return this.start(session, procedure);
    }
    if (session.procedure_version !== (procedure.version || null)) {
      return this.response("PROCEDURE_VERSION_MISMATCH", { ...session, status: "PAUSED", step_state: "ERROR" }, procedure,
        "当前会话与流程版本不一致。已暂停，请重新选择并开始流程，不迁移旧确认数据。");
    }
    const step = procedure.steps.find((item) => item.step_id === session.current_step);
    if (!step) {
      return this.response("PROCEDURE_ERROR", { ...session, status: "PAUSED", step_state: "ERROR" }, procedure,
        "当前流程步骤配置缺失。流程已暂停，请检查流程版本。");
    }

    if (intent === "STATUS") return this.response("GUIDANCE_STATUS", session, procedure, this.describeStatus(session, step));
    if (intent === "SUMMARY") return this.response("GUIDANCE_SUMMARY", session, procedure, this.summarize(session, procedure));
    if (intent === "STEP_HELP") return this.response("STEP_HELP", session, procedure,
      "当前是" + step.name + "。需要口述：" + (step.required_inputs || []).map((input) => input.label).join("；") + "。"
      + (["PAUSED", "EXCEPTION_REPORTED"].includes(session.status) ? "流程保持暂停。" : "")
      + this.describeMissingInputs(step, session)
      + (step.missing_details?.length ? "尚缺任务资料：" + step.missing_details.join("；") + "。不能生成这些具体操作。" : "现有配置只支持项目核对，具体动作必须依据任务SOP。"));
    if (intent === "REPEAT") {
      const prefix = ["PAUSED", "EXCEPTION_REPORTED"].includes(session.status) ? "流程保持暂停。以下复述当前步骤内容。" : "";
      const prompt = session.step_state === "WAITING_STEP_CONFIRMATION" ? this.confirmationPrompt(step, session.step_observations) : this.buildStepPrompt(step, session);
      return this.response("GUIDANCE_REPEATED", session, procedure, prefix + prompt);
    }
    if (session.status === "COMPLETED") {
      return this.response("PROCEDURE_COMPLETED", session, procedure, "本次流程已结束。可以说总结，或选择另一个实验。");
    }
    if (intent === "RECHECK_STEP") {
      if (session.status !== "GUIDING") return this.response("STEP_RECHECK_BLOCKED", session, procedure,
        "当前流程暂停，不能通过重新核对解除暂停。请先按原暂停原因完成恢复确认；异常暂停仍需报告评估结果、恢复条件和地面指令。");
      const observations = { ...(session.observations || {}) };
      for (const input of step.required_inputs || []) delete observations[input.name];
      const nextSession = {
        ...session, observations, step_observations: {}, step_state: "WAITING_INPUT",
        pending_confirmation: null, last_operator_feedback: query,
        event_log: this.appendEvent(session.event_log, "STEP_RECHECK_REQUESTED", {
          step_id: step.step_id, previous_observations: { ...(session.step_observations || {}) },
          previous_step_state: session.step_state, independently_verified: false,
        }),
      };
      return this.response("STEP_RECHECK_STARTED", nextSession, procedure,
        "已撤回本步骤未确认的数据，原报告保留在事件记录中。步骤位置和已完成记录不变。仅重新核对口述记录，无需重复实验动作。" + this.promptForInput(step.required_inputs[0]));
    }
    if (intent === "EXCEPTION") {
      if (session.last_exception && ["PAUSED", "EXCEPTION_REPORTED"].includes(session.status)) {
        const collected = collectExceptionDetails(session.last_exception, query);
        if (collected.changed) return this.recordExceptionDetails(session, procedure, step, query, collected);
      }
      const exception = createException(query);
      const nextSession = {
        ...session,
        status: "EXCEPTION_REPORTED",
        step_state: "AWAITING_EXCEPTION_ASSESSMENT",
        pending_confirmation: null,
        pause_reason: "EXCEPTION",
        last_exception: exception,
        last_operator_feedback: query,
        event_log: this.appendEvent(session.event_log, "EXCEPTION_REPORTED", { step_id: step.step_id, query }),
      };
      return this.response("EXCEPTION_REPORTED", nextSession, procedure,
        "已记录异常。" + exceptionPrompt(exception));
    }
    if (intent === "PAUSE") {
      const alreadyPaused = ["PAUSED", "EXCEPTION_REPORTED"].includes(session.status);
      const nextSession = {
        ...session,
        status: alreadyPaused ? session.status : "PAUSED",
        step_state: alreadyPaused ? session.step_state : "PAUSED",
        paused_from_step_state: alreadyPaused ? session.paused_from_step_state : session.step_state,
        pause_reason: alreadyPaused ? session.pause_reason : "OPERATOR",
        last_operator_feedback: query,
        event_log: this.appendEvent(session.event_log, "GUIDANCE_PAUSED", { step_id: step.step_id, query }),
      };
      return this.response("GUIDANCE_PAUSED", nextSession, procedure, "已暂停语音流程引导，当前步骤和已报告数据已保留。");
    }
    if (["PAUSED", "EXCEPTION_REPORTED"].includes(session.status)) {
      if (session.last_exception && !["RESUME", "CONFIRM"].includes(intent)) {
        const collected = collectExceptionDetails(session.last_exception, query);
        if (collected.changed) return this.recordExceptionDetails(session, procedure, step, query, collected);
      }
      if (intent === "RESUME" || intent === "CONFIRM") {
        if (session.pause_reason === "OPERATOR" && !session.last_exception) {
          const nextSession = {
            ...session,
            status: "GUIDING",
            step_state: session.paused_from_step_state || "WAITING_INPUT",
            pause_reason: null,
            event_log: this.appendEvent(session.event_log, "GUIDANCE_RESUMED", { step_id: step.step_id, query }),
          };
          const prompt = nextSession.step_state === "WAITING_STEP_CONFIRMATION"
            ? this.confirmationPrompt(step, nextSession.step_observations)
            : this.buildStepPrompt(step, nextSession);
          return this.response("GUIDANCE_RESUMED", nextSession, procedure, "已恢复到原步骤。" + prompt);
        }
        if (intent === "RESUME" && this.hasReportedResumeBasis(query)) {
          const observations = { ...(session.observations || {}) };
          for (const input of step.required_inputs || []) delete observations[input.name];
          const nextSession = {
            ...session,
            status: "GUIDING",
            step_state: "WAITING_INPUT",
            step_observations: {},
            observations,
            pending_confirmation: null,
            pause_reason: null,
            last_exception: null,
            event_log: this.appendEvent(session.event_log, "OPERATOR_REPORTED_RESUME_BASIS", {
              step_id: step.step_id, query, independently_verified: false,
            }),
          };
          return this.response("GUIDANCE_RESUMED", nextSession, procedure,
            "已记录你报告的异常评估、恢复条件及地面指令。恢复后先重新核对本步骤的数据。" + this.buildStepPrompt(step, nextSession));
        }
      }
      const nextSession = {
        ...session,
        event_log: this.appendEvent(session.event_log, "PAUSED_FEEDBACK", { step_id: step.step_id, query }),
      };
      return this.response("RESUME_REQUIRES_CONFIRMATION", nextSession, procedure,
        session.pause_reason === "OPERATOR"
          ? "当前引导仍然暂停。请说恢复流程，再报告本步骤数据。"
          : "异常暂停尚未解除。请报告异常评估结果、恢复条件是否满足和地面允许的恢复指令。补报数据不能直接推进步骤。");
    }
    if (intent === "RESUME" || intent === "START") {
      return this.response("GUIDANCE_STATUS", session, procedure, "流程已在进行中。" + this.describeStatus(session, step));
    }

    const previousValues = session.step_observations || {};
    const extracted = extractStepInputs(step, query, previousValues);
    const values = { ...previousValues, ...extracted.values };
    const observations = { ...(session.observations || {}), ...extracted.values };
    for (const field of extracted.ambiguous) {
      delete values[field];
      delete observations[field];
    }
    const hasNewInput = Object.keys(extracted.values).length > 0 || extracted.ambiguous.length > 0;
    const feedbackSession = {
      ...session,
      step_observations: values,
      observations,
      last_operator_feedback: query,
      step_state: hasNewInput ? "WAITING_INPUT" : session.step_state,
      pending_confirmation: hasNewInput ? null : session.pending_confirmation,
      event_log: this.appendEvent(session.event_log, "OPERATOR_FEEDBACK", {
        step_id: step.step_id, query, extracted: extracted.values, ambiguous_fields: extracted.ambiguous,
      }),
    };
    if (extracted.ambiguous.length > 0) {
      const input = step.required_inputs.find((item) => item.name === extracted.ambiguous[0]);
      return this.response("STEP_INPUT_AMBIGUOUS", feedbackSession, procedure,
        "这条反馈不明确或格式无法核对，尚未确认。" + this.promptForInput(input));
    }
    const missing = (step.required_inputs || []).filter((input) => values[input.name] === undefined);
    if (missing.length > 0) {
      return this.response("STEP_WAITING_INPUT", feedbackSession, procedure,
        (hasNewInput ? "已记录报告的数据。" : "当前步骤还缺少反馈，不能进入下一步。") + this.promptForInput(missing[0]));
    }
    const validation = this.validateStep(step, values);
    if (!validation.ok) {
      const failure = step.on_validation_fail || {};
      const nextSession = {
        ...feedbackSession,
        status: "PAUSED",
        step_state: "PAUSED",
        pending_confirmation: null,
        pause_reason: "VALIDATION_FAILED",
        last_exception: {
          ...createException(query, "PARAMETER_DEVIATION"),
          reason: failure.reason || "VALIDATION_FAILED",
          deviation: validation.deviation,
          timestamp_utc: new Date().toISOString(),
        },
        event_log: this.appendEvent(feedbackSession.event_log, "VALIDATION_FAILED", {
          step_id: step.step_id, reason: failure.reason || "VALIDATION_FAILED", deviation: validation.deviation,
        }),
      };
      return this.response("VALIDATION_FAILED", nextSession, procedure,
        (failure.fixed_alert || "校验未通过。暂停当前步骤。") + " " + (failure.handling || "请按当前实验的异常处置规则核对。"));
    }

    // Read the values back in one turn; only a later confirmation can advance.
    if (intent !== "CONFIRM" || session.step_state !== "WAITING_STEP_CONFIRMATION" || hasNewInput) {
      const nextSession = { ...feedbackSession, step_state: "WAITING_STEP_CONFIRMATION", pending_confirmation: step.expected_confirmation || step.name };
      return this.response("STEP_AWAITING_CONFIRMATION", nextSession, procedure, this.confirmationPrompt(step, values));
    }
    const nextStep = step.next_step ? procedure.steps.find((item) => item.step_id === step.next_step) : null;
    if (step.next_step && !nextStep) {
      return this.response("PROCEDURE_ERROR", { ...feedbackSession, status: "PAUSED", step_state: "ERROR" }, procedure,
        "下一步配置缺失，流程已暂停。请检查流程版本。");
    }
    const confirmedSession = {
      ...feedbackSession,
      completed_steps: [...(session.completed_steps || []), step.step_id],
      step_records: { ...(session.step_records || {}), [step.step_id]: {
        name: step.name, observations: { ...values }, evidence_status: "OPERATOR_REPORTED",
        independently_verified: false, confirmed_at_utc: new Date().toISOString(),
        procedure_version: procedure.version || null, source_refs: step.source_refs || procedure.source_refs || [],
      } },
      pending_confirmation: null,
      event_log: this.appendEvent(feedbackSession.event_log, "STEP_COMPLETED", {
        procedure_id: procedure.procedure_id, step_id: step.step_id, next_step: nextStep?.step_id || null, observations: values,
      }),
    };
    if (!nextStep) {
      return this.response("PROCEDURE_COMPLETED", {
        ...confirmedSession,
        status: "COMPLETED",
        step_state: "COMPLETED",
        event_log: this.appendEvent(confirmedSession.event_log, "PROCEDURE_COMPLETED", { procedure_id: procedure.procedure_id }),
      }, procedure, step.completion_message || "当前实验流程已完成。");
    }
    const nextSession = {
      ...confirmedSession,
      status: "GUIDING",
      current_step: nextStep.step_id,
      step_state: "WAITING_INPUT",
      step_observations: {},
    };
    return this.response("STEP_GUIDANCE", nextSession, procedure,
      (step.completion_message || "当前步骤已确认。") + " " + this.buildStepPrompt(nextStep, nextSession));
  }

  hasReportedResumeBasis(query) {
    return !/(不确定|可能|假如|如果|假设|未评估|尚未评估|未处理|未满足|不满足|未允许|不允许|未同意|不同意|没有.{0,6}(允许|同意)|地面.{0,6}(拒绝|禁止|不批准)|不恢复|不能恢复)/u.test(query)
      && /(异常已评估|异常已处理|偏差已评估|问题已处理)/u.test(query)
      && /(恢复条件已满足|恢复条件满足)/u.test(query)
      && /(地面(?:已)?(?:允许|同意)|地面已确认允许)/u.test(query);
  }

  validateStep(step, observations) {
    for (const rule of step.validation_rules || []) {
      if (!this.evaluateRule(rule, observations)) return { ok: false, deviation: JSON.stringify(observations) };
    }
    return { ok: true, deviation: null };
  }

  evaluateRule(rule, observations) {
    if (rule.all) return rule.all.every((item) => this.evaluateRule(item, observations));
    if (rule.any) return rule.any.some((item) => this.evaluateRule(item, observations));
    if (!rule.field) return false;
    const actual = observations[rule.field];
    if (actual === undefined) return false;
    switch (rule.operator) {
      case "present": return typeof actual === "string" && actual.trim().length > 0;
      case "equals": return actual === rule.value;
      case ">": return actual > rule.value;
      case ">=": return actual >= rule.value;
      case "<": return actual < rule.value;
      case "<=": return actual <= rule.value;
      default: return false;
    }
  }

  formatValue(input, value) {
    if (input.type === "boolean") return value ? "是" : "否";
    if (input.type === "enum") return input.options?.[value]?.[0] || String(value);
    if (input.type === "identifier") return String(value);
    if (input.type === "datetime_utc") {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(value);
      return match ? `${match[1]}年${match[2]}月${match[3]}日${match[4]}时${match[5]}分${match[6]}秒，UTC` : "未核对的时间";
    }
    const spokenNumber = value < 0 ? "负" + Math.abs(value) : String(value);
    const unit = input.unit === "℃" ? "摄氏度" : input.unit === "%" ? "百分比" : (input.unit || "");
    return unit === "百分比" ? "百分之" + spokenNumber : spokenNumber + unit;
  }

  describeValues(step, values = {}) {
    return (step.required_inputs || [])
      .filter((input) => values[input.name] !== undefined)
      .map((input) => input.label + "：" + this.formatValue(input, values[input.name])).join("；");
  }

  confirmationPrompt(step, values) {
    return "读回本步骤数据：" + this.describeValues(step, values)
      + "。请核对。正确请说确认无误；有误请报告需要更正的项目和数值。";
  }

  promptForInput(input) {
    const unit = input.unit ? "，单位为" + input.unit : "";
    return "请提供" + input.label + unit + "。"
      + (input.type === "datetime_utc" ? "请使用UTC，逐项报告年份、月份、日期、时、分、秒。不自动换算本地时间。" : "")
      + (input.type === "identifier" ? "请报告完整编号，我会原样读回；不猜测识别错误。" : "");
  }

  describeMissingInputs(step, session) {
    if (session.status === "COMPLETED") return "本次流程的交互核对已完成。";
    const missing = (step.required_inputs || []).filter((input) => session.step_observations?.[input.name] === undefined);
    if (missing.length) return "还缺：" + missing.map((input) => input.label).join("；") + "。";
    if (session.step_state === "WAITING_STEP_CONFIRMATION") return "所需数据已报告，等待核对确认；查询不会代替确认。";
    return "所需数据已报告；查询不会解除暂停或推进步骤。";
  }

  buildStepPrompt(step, session) {
    const preconditions = step.preconditions?.length ? "开始前请确认：" + step.preconditions.join("；") + "。" : "";
    const missing = (step.required_inputs || []).find((input) => session.step_observations?.[input.name] === undefined);
    return step.spoken_instruction + " " + preconditions + " "
      + (missing ? this.promptForInput(missing) : "请报告该步骤的完成结果和实验现象。");
  }

  describeStatus(session, step) {
    const status = { GUIDING: "引导中", PAUSED: "暂停", EXCEPTION_REPORTED: "异常待处理", COMPLETED: "完成" }[session.status] || session.status;
    const pending = session.step_state === "WAITING_STEP_CONFIRMATION" ? "已读回数据，等待确认。" : "";
    return "当前步骤：" + step.name + "。状态：" + status + "。" + pending;
  }

  summarize(session, procedure) {
    const records = Object.entries(session.step_records || {}).map(([stepId, record]) => {
      const step = procedure.steps.find((item) => item.step_id === stepId);
      return step ? record.name + "，" + this.describeValues(step, record.observations) : "";
    }).filter(Boolean);
    const step = procedure.steps.find((item) => item.step_id === session.current_step);
    const current = this.describeValues(step || {}, session.step_observations);
    return "已确认完成" + (session.completed_steps?.length || 0) + "个步骤。记录来自操作者口述，尚未经独立验证。"
      + (records.length ? records.join("。") + "。" : "")
      + (current ? "当前步骤已报告：" + current + "。" : "")
      + (step ? this.describeStatus(session, step) : "")
      + (session.last_exception ? exceptionPrompt(session.last_exception) : "");
  }

  recordExceptionDetails(session, procedure, step, query, collected) {
    const nextSession = { ...session, last_exception: collected.exception,
      event_log: this.appendEvent(session.event_log, "EXCEPTION_DETAILS_REPORTED", {
        step_id: step.step_id, details: collected.exception.details, independently_verified: false,
      }) };
    return this.response("EXCEPTION_DETAILS_RECORDED", nextSession, procedure, exceptionPrompt(collected.exception));
  }

  appendEvent(events, eventType, data) {
    return [...(events || []), { timestamp_utc: new Date().toISOString(), event_type: eventType, data }];
  }
}

module.exports = { ProcedureEngine };
