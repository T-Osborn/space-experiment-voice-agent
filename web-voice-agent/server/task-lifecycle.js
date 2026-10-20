function exportTask(session, procedureRegistry) {
  const procedure = procedureRegistry.getForExperiment(session.experiment_id);
  const snapshot = structuredClone(session);
  delete snapshot.pending_task_change;
  return {
    filename: `experiment-record-${session.session_id.slice(-12)}-${Date.now()}.json`,
    data: {
      schema_version: "1.0", exported_at: new Date().toISOString(),
      record_kind: "OPERATOR_REPORTED_DEMO_RECORD",
      device_verified: false, flight_approved: false,
      note: "口述及交互核对记录；不是仪器原始数据或实验完成证明。未确认的数据仍保留未确认状态。",
      procedure: procedure ? { procedure_id: session.procedure_id || procedure.procedure_id,
        version: session.procedure_id ? (session.procedure_version || null) : procedure.version,
        loaded_version: procedure.version,
        version_matches_loaded_configuration: session.procedure_id ? session.procedure_id === procedure.procedure_id
          && session.procedure_version === (procedure.version || null) : null,
        sop_status: procedure.sop_status } : null,
      session: snapshot,
    },
  };
}

function taskHelp(session, questions = []) {
  const introduction = "我是在轨实验助手，通过语音帮助你查资料、核对步骤和记录反馈，实际操作由你完成。";
  const knowledgeHelp = "专业知识可以直接提问，无需先开始流程。" + (questions.length ? "例如：" + questions.join("；") + "。" : "");
  if (!session.experiment_id) return `${introduction}${knowledgeHelp}需要演示步骤时，你可以说有哪些实验，或选择太空水稻实验。选择后说开始流程。`;
  return `${introduction}${knowledgeHelp}你可以说当前状态、本步还缺什么、再说一遍、暂停、恢复流程、读回数据、保存记录或查看历史记录。报告数据后，我会读回，等你说确认无误再推进。需要重新报告本步未确认数据时，说重新核对本步骤。普通暂停可直接恢复，异常暂停需核对恢复依据。重新开始和切换实验需要单独确认。`;
}

module.exports = { exportTask, taskHelp };
