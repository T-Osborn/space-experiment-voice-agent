// Developer-only rehearsal: simulated ASR transcripts, not microphone or cloud speech.
// Outputs evidence to stdout; does not expose a text-chat UI or change production config.
const assert = require("node:assert/strict");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { riceReports } = require("./demo-inputs");
const { SemanticAdapter } = require("../server/semantic-adapter");

const cultivation = "培养周期九十五天，成熟度评估已完成，种子已成熟，营养液剩余百分之二十五";
const scenarios = [
  { name: "rice_complete_with_query_and_repeat", utterances: [
    "选择太空水稻在轨取样预处理实验", "开始流程", "下一步", cultivation, "确认无误",
    "温度负八十度", "再说一遍", "项目水稻演示中的MELFI温度与NASA公开资料一致吗", "确认无误",
    ...riceReports.slice(2).flatMap((report) => [report, "确认无误"]), "总结",
  ] },
  { name: "exception_holds_then_rechecks", utterances: [
    "选择太空水稻在轨取样预处理实验", "开始流程", cultivation, "确认无误",
    "温度负六十度", "温度负八十度", "继续", "当前MELFI温度是多少",
    "异常已评估，恢复条件已满足，地面同意恢复流程", "下一步", "温度负八十度", "确认无误",
    ...riceReports.slice(2).flatMap((report) => [report, "确认无误"]), "总结",
  ] },
  { name: "identity_exception_collects_details_then_rechecks", utterances: [
    "选择太空水稻实验", "开始流程", ...riceReports.slice(0, 5).flatMap((report) => [report, "确认无误"]),
    "容器标签不一致，怎么办？", "受影响对象容器BOX-01", "异常现象标签与取样记录不一致",
    "已采取处置暂未重新包装，等待任务方评估", "继续",
    "异常已评估，恢复条件已满足，地面同意恢复流程",
    ...riceReports.slice(5).flatMap((report) => [report, "确认无误"]), "总结",
  ] },
  { name: "operator_recheck_keeps_confirmed_history", utterances: [
    "选择太空水稻实验", "开始流程", "培养周期九十五天", "本步还缺什么", cultivation,
    "重新核对本步骤", "确认无误", cultivation, "确认无误",
    "温度负八十度", "重新核对本步骤", "温度负八十二度", "这一步还缺什么", "确认无误",
    ...riceReports.slice(2).flatMap((report) => [report, "确认无误"]), "总结", "保存记录",
  ] },
];

async function runRehearsal() {
  const result = {
    input_mode: "SIMULATED_ASR_TEXT", real_audio_verified: false,
    cloud_speech_called: false, device_connected: false,
    procedure_status: "PROJECT_DEMO_REVIEW_REQUIRED",
    warning: "仅验证软件对话行为。样例数值来自项目演示配置，不是已审核的飞行参数。恢复依据为模拟操作者口述，未经独立验证。",
    scenarios: [],
  };
  for (const scenario of scenarios) {
    const agent = new AgentOrchestrator({ semanticAdapter: new SemanticAdapter({ env: {} }) });
    let session = agent.createSession();
    const turns = [];
    for (const utterance of scenario.utterances) {
      const response = await agent.handleVoiceTurn({ session, recognized_text: utterance });
      session = response.session;
      turns.push({
        operator: utterance, response_type: response.response_type, agent: response.speech_text,
        current_step: session.current_step, step_state: session.step_state,
        status: session.status, completed_steps: session.completed_steps?.length || 0,
        evidence: response.knowledge.matched_records.map((record) => ({
          record_id: record.record_id, sources: record.sources,
        })),
      });
    }
    assert.equal(session.status, "COMPLETED");
    assert.equal(session.completed_steps.length, 9);
    if (scenario.name.startsWith("rice")) {
      assert.equal(turns[2].response_type, "STEP_WAITING_INPUT");
      assert.equal(turns[7].response_type, "SOURCE_CONFLICT");
      assert.equal(turns[7].current_step, turns[6].current_step);
    } else if (scenario.name === "exception_holds_then_rechecks") {
      assert.equal(turns[4].response_type, "VALIDATION_FAILED");
      assert.equal(turns[5].response_type, "RESUME_REQUIRES_CONFIRMATION");
      assert.equal(turns[6].status, "PAUSED");
      assert.equal(turns[7].response_type, "KNOWLEDGE_NO_TELEMETRY");
      assert.equal(turns[9].response_type, "STEP_WAITING_INPUT");
      const recovery = session.event_log.find((event) => event.event_type === "OPERATOR_REPORTED_RESUME_BASIS");
      assert.equal(recovery.data.independently_verified, false);
    } else if (scenario.name === "identity_exception_collects_details_then_rechecks") {
      const exception = turns.find((item) => item.response_type === "EXCEPTION_REPORTED");
      assert.equal(exception.current_step, "container_identity_check");
      const details = turns.filter((item) => item.response_type === "EXCEPTION_DETAILS_RECORDED");
      assert.equal(details.length, 3); assert.ok(details.every((item) => item.status === "EXCEPTION_REPORTED"));
      assert.ok(turns.some((item) => item.response_type === "RESUME_REQUIRES_CONFIRMATION"));
    } else if (scenario.name === "operator_recheck_keeps_confirmed_history") {
      assert.equal(turns[3].response_type, "STEP_HELP");
      assert.equal(turns[5].response_type, "STEP_RECHECK_STARTED");
      assert.equal(turns[6].response_type, "STEP_WAITING_INPUT");
      assert.equal(turns[10].response_type, "STEP_RECHECK_STARTED");
      assert.equal(turns[10].completed_steps, 1);
      assert.equal(turns.at(-1).response_type, "RECORD_EXPORT");
      assert.equal(session.step_records.melfi_storage_check.observations.melfi_temperature_c, -82);
      const events = session.event_log.filter(event => event.event_type === "STEP_RECHECK_REQUESTED");
      assert.equal(events.length, 2);
      assert.equal(events[1].data.previous_observations.melfi_temperature_c, -80);
    }
    result.scenarios.push({ name: scenario.name, turns, final_status: session.status, confirmed_steps: 9,
      final_records: session.step_records,
      recheck_events: session.event_log.filter(event => event.event_type === "STEP_RECHECK_REQUESTED") });
  }
  return result;
}

if (require.main === module) runRehearsal().then((result) => {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}).catch((error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });

module.exports = { runRehearsal, scenarios };
