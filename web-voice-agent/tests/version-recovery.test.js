const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { SessionStore } = require("../server/deployment-security");
const { RecordRepository } = require("../server/record-repository");

const makeAgent = () => new AgentOrchestrator({ semanticAdapter: { select: async () => null } });
const say = (agent, session, recognized_text) => agent.handleVoiceTurn({ session, recognized_text });
async function oldTask() {
  const agent = makeAgent();
  let result = await say(agent, agent.createSession(), "选择太空水稻实验");
  result = await say(agent, result.session, "开始流程");
  result = await say(agent, result.session, "培养周期九十五天");
  return { agent, session: { ...result.session, procedure_version: "0.2-historical-fixture", status: "PAUSED", pause_reason: "OPERATOR" } };
}

test("same-experiment reselection identifies stale state without repeating the select-and-start loop", async () => {
  const { agent, session } = await oldTask();
  const selected = await say(agent, session, "选择太空水稻实验");
  assert.equal(selected.response_type, "PROCEDURE_VERSION_MISMATCH");
  assert.equal(selected.session.pause_reason, "PROCEDURE_VERSION_MISMATCH");
  assert.deepEqual(selected.session.step_observations, session.step_observations);
  assert.equal(selected.session.procedure_version, session.procedure_version);
  assert.match(selected.speech_text, /请说重新开始/u);
  assert.match(selected.progress.next_action, /重新开始/u);
  assert.doesNotMatch(selected.progress.next_action, /说恢复流程回到/u);
  const repeated = await say(agent, selected.session, "当前状态");
  assert.equal(repeated.session.event_log.length, selected.session.event_log.length);
});

test("start with a stale task requests explicit restart confirmation and preserves old reports until then", async () => {
  const { agent, session } = await oldTask();
  const request = await say(agent, session, "开始流程");
  assert.equal(request.response_type, "TASK_CHANGE_REQUIRED");
  assert.equal(request.session.pending_task_change.kind, "RESTART");
  assert.match(request.speech_text, /版本不一致/u);
  assert.deepEqual(request.session.step_observations, session.step_observations);
  assert.match(request.progress.next_action, /确认重新开始/u);
  const repeated = await say(agent, request.session, "开始流程");
  assert.equal(repeated.response_type, "TASK_CHANGE_REQUIRED");
  const status = await say(agent, repeated.session, "当前状态");
  assert.equal(status.session.pending_task_change.kind, "RESTART");
  const restart = await say(agent, status.session, "确认重新开始");
  assert.equal(restart.response_type, "STEP_GUIDANCE");
  assert.equal(restart.session.status, "GUIDING");
  assert.equal(restart.session.procedure_version, agent.procedureRegistry.getForExperiment(session.experiment_id).version);
  assert.deepEqual(restart.session.step_observations, {});
  assert.equal(restart.session.completed_steps.length, 0);
  assert.deepEqual(restart.record_export.data.session.step_observations, session.step_observations);
  assert.equal(restart.record_export.data.procedure.version, session.procedure_version);
  assert.equal(restart.record_export.data.procedure.loaded_version, restart.session.procedure_version);
  assert.equal(restart.record_export.data.procedure.version_matches_loaded_configuration, false);
  assert.equal((await say(agent, restart.session, "开始流程")).response_type, "GUIDANCE_STATUS");
});

test("cancel and ordinary confirmation cannot silently replace stale task state", async () => {
  const { agent, session } = await oldTask();
  const request = await say(agent, session, "开始流程");
  const cancelled = await say(agent, request.session, "取消重新开始");
  assert.equal(cancelled.session.pending_task_change, null);
  assert.equal(cancelled.session.procedure_version, session.procedure_version);
  assert.deepEqual(cancelled.session.step_observations, session.step_observations);
  const wrong = await say(agent, request.session, "确认无误");
  assert.equal(wrong.response_type, "PROCEDURE_VERSION_MISMATCH");
  assert.equal(wrong.session.pending_task_change, null);
  const staleConfirmation = await say(agent, wrong.session, "确认重新开始");
  assert.equal(staleConfirmation.response_type, "TASK_CHANGE_REQUIRED");
  assert.equal(staleConfirmation.session.procedure_version, session.procedure_version);
  assert.equal(staleConfirmation.record_export, undefined);
});

test("the existing two-command restart safely exits a stale task and keeps an old exception in its archive", async () => {
  const { agent, session } = await oldTask();
  const exception = { exception_type: "fixture-only", details: { affected_object: "software fixture" } };
  const stale = { ...session, last_exception: exception, unresolved_conflicts: [{ id: "fixture-conflict" }] };
  const request = await say(agent, stale, "重新开始");
  const result = await say(agent, request.session, "确认重新开始");
  assert.equal(result.response_type, "STEP_GUIDANCE");
  assert.deepEqual(result.record_export.data.session.last_exception, exception);
  assert.deepEqual(result.record_export.data.session.unresolved_conflicts, stale.unresolved_conflicts);
  assert.equal(result.session.last_exception, null);
  assert.deepEqual(result.session.unresolved_conflicts, []);
});

test("resume and a changed procedure id cannot bypass version protection", async () => {
  const { agent, session } = await oldTask();
  for (const state of [session, { ...session, procedure_id: "historical-procedure-id" }]) {
    const result = await say(agent, state, "恢复流程");
    assert.equal(result.response_type, "PROCEDURE_VERSION_MISMATCH");
    assert.equal(result.session.procedure_id, state.procedure_id);
    assert.deepEqual(result.session.step_observations, state.step_observations);
  }
});

test("knowledge queries remain read-only and their progress does not recommend normal resume for a stale task", async () => {
  const { agent, session } = await oldTask();
  const result = await say(agent, session, "NASA的流体与燃烧设施FCF由哪些实验柜组成？");
  assert.equal(result.response_type, "KNOWLEDGE_ANSWER");
  assert.deepEqual(result.session, session);
  assert.equal(result.progress.paused, true);
  assert.match(result.progress.next_action, /重新开始/u);
});

test("stale-task restart archives once across SQLite restart and request retries", async t => {
  const { session } = await oldTask();
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, "voice-version-recovery-"));
  let repository;
  t.after(() => {
    repository?.close();
    assert.equal(path.dirname(directory), parent); assert.match(path.basename(directory), /^voice-version-recovery-/u);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  repository = new RecordRepository({ directory });
  let store = new SessionStore({ repository }); let agent = makeAgent();
  const initial = store.create("owner", session);
  const request = await store.turn(initial.session_id, "owner", saved => say(agent, saved, "开始流程"));
  repository.close(); repository = new RecordRepository({ directory }); store = new SessionStore({ repository }); agent = makeAgent();
  const options = { text: "确认重新开始", requestId: "version-restart-confirm-0001", expectedRevision: request.session.revision };
  const confirmation = () => store.turn(initial.session_id, "owner", saved => say(agent, saved, "确认重新开始"), options);
  const first = await confirmation(); const retry = await confirmation();
  assert.deepEqual(retry, first);
  assert.equal(repository.history("owner").length, 1);
  const archive = repository.archive(repository.history("owner")[0].id, "owner");
  assert.equal(archive.session.procedure_version, session.procedure_version);
  assert.deepEqual(archive.session.step_observations, session.step_observations);
  assert.equal(store.get(initial.session_id, "owner").session.procedure_version, first.session.procedure_version);
});
