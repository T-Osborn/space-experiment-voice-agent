const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ExperimentRegistry } = require("../server/experiment-registry");
const { ProcedureRegistry } = require("../server/procedure-registry");
const { ProcedureEngine } = require("../server/procedure-engine");

function dashboard() {
  const nodes = new Map();
  const node = () => ({ textContent: "", className: "", dataset: {}, children: [],
    classList: { toggle() {} }, append(...values) { this.children.push(...values); },
    replaceChildren() { this.children = []; }, setAttribute(name, value) { this[name] = value; } });
  const context = vm.createContext({ window: {}, document: {
    querySelector: (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    createElement: node,
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/dashboard.js"), "utf8"), context);
  const registry = new ProcedureRegistry();
  context.window.VoiceDashboard.load({
    capabilities: { experiment_count: 20, demo_procedure_count: 1, core_question_count: 20, expanded_question_count: 16, curated_question_count: 36, public_source_count: 46 },
    experimentData: { experiments: new ExperimentRegistry().list() },
    procedureData: { procedures: registry.list().map((p) => ({ ...p, steps: registry.getForExperiment(p.experiment_id).steps })), review_drafts: registry.listDrafts() },
    voice: { asr: { configured: false }, tts: { configured: false } },
  });
  return { api: context.window.VoiceDashboard, nodes, procedure: registry.procedures[0] };
}

test("read-only dashboard distinguishes 20 directory items from one unreviewed demo", () => {
  const { nodes } = dashboard();
  const cards = nodes.get("#experimentDirectory").children;
  assert.equal(cards.length, 20); assert.equal(cards.filter((card) => card.className.includes("has-demo")).length, 1);
  assert.ok(cards.every((card) => card.children[1].textContent.includes("待")));
  assert.equal(nodes.get("#voicePhase").textContent, "等待接入");
  assert.equal(nodes.get("#questionCount").textContent, "36");
  assert.equal(nodes.get("#sourceCount").textContent, "46");
  assert.equal(cards.filter(card => card.children[1].textContent.includes("待审草案")).length, 4);
  assert.match(nodes.get("#understandingStatus").textContent, /题库可用/u);
});

test("timeline reflects confirmed steps without showing the current unconfirmed step as complete", () => {
  const { api, nodes, procedure } = dashboard();
  api.update({ session: { experiment_id: procedure.experiment_id, procedure_id: procedure.procedure_id,
    current_step: procedure.steps[1].step_id, completed_steps: [procedure.steps[0].step_id] } });
  const rows = nodes.get("#stepTimeline").children;
  assert.equal(rows.length, 9); assert.equal(rows[0].className, "complete"); assert.equal(rows[1].className, "active");
  assert.equal(rows[1]["aria-current"], "step"); assert.equal(nodes.get("#progressLabel").textContent, "已确认 1 / 9 步");
  api.update({ session: { experiment_id: "protein_crystallization", completed_steps: [] } });
  assert.match(nodes.get("#procedureScope").textContent, /专家尚未签审/u);
});

test("public UI keeps chat voice-only and sends session id rather than client-owned state", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  assert.doesNotMatch(html, /<input|<textarea|contenteditable|onclick=/iu);
  assert.match(app, /session_id: session.session_id/u);
  assert.doesNotMatch(app, /JSON.stringify\(\{ session,/u);
  assert.match(app, /history.replaceState/u); assert.match(app, /SESSION_LOADED/u);
});

test("generated responses are not falsely presented as heard speech or verified experiment completion", () => {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /EXCEPTION_DETAILS_RECORDED:/u); assert.match(app, /STEP_HELP:/u);
  assert.match(app, /PROCEDURE_VERSION_MISMATCH:/u); assert.match(app, /PROCEDURE_REVIEW_REQUIRED:/u);
  assert.doesNotMatch(app, /已收到播报|已播报下一步|COMPLETED: "实验已完成"/u);
});

test("V2 dashboard displays backend-reported values, missing fields and rule-conflict decisions", () => {
  const { api, nodes, procedure } = dashboard();
  const session = { procedure_id: procedure.procedure_id, procedure_version: procedure.version, experiment_id: procedure.experiment_id,
    current_step: procedure.steps[0].step_id, completed_steps: [], step_observations: { cultivation_days: 95 },
    status: "GUIDING", step_state: "WAITING_INPUT" };
  const engine = new ProcedureEngine();
  api.update({ session, progress: engine.progress(session, procedure) });
  assert.match(nodes.get("#reportedInputs").textContent, /95天/u);
  assert.match(nodes.get("#pendingInputs").textContent, /种子.*营养液/u);
  assert.doesNotMatch(nodes.get("#pendingInputs").textContent, /周期天数/u);
  const paused = { ...session, status: "PAUSED", step_state: "RULE_CONFLICT", pause_reason: "RULE_CONFLICT" };
  api.update({ session: paused, progress: engine.progress(paused, procedure), knowledge: { retrieval_status: "FAILED" } });
  assert.match(nodes.get("#stepDecision").textContent, /资料冲突/u);
  assert.match(nodes.get("#nextAction").textContent, /确认适用规则/u);
  assert.match(nodes.get("#understandingStatus").textContent, /检索失败/u);
});

test("stale task progress recommends explicit new-task confirmation instead of normal resume", () => {
  const { api, nodes, procedure } = dashboard();
  const session = { procedure_id: procedure.procedure_id, procedure_version: "old-fixture", experiment_id: procedure.experiment_id,
    current_step: procedure.steps[0].step_id, completed_steps: [], step_observations: {}, status: "PAUSED", pause_reason: "OPERATOR" };
  const engine = new ProcedureEngine();
  api.update({ session, progress: engine.progress(session, procedure) });
  assert.match(nodes.get("#stepDecision").textContent, /版本不一致/u);
  assert.match(nodes.get("#nextAction").textContent, /重新开始/u);
  assert.doesNotMatch(nodes.get("#nextAction").textContent, /说恢复流程回到原步骤/u);
  const waiting = { ...session, pending_task_change: { kind: "RESTART", query: "开始流程" } };
  api.update({ session: waiting, progress: engine.progress(waiting, procedure) });
  assert.match(nodes.get("#nextAction").textContent, /确认重新开始/u);
});
