const test = require("node:test");
const assert = require("node:assert/strict");
const { ProcedureRegistry, validateReviewDrafts } = require("../server/procedure-registry");
const { ProcedureEngine } = require("../server/procedure-engine");
const { ExperimentRegistry } = require("../server/experiment-registry");
const { AgentOrchestrator } = require("../server/agent-orchestrator");
const { extractStepInputs } = require("../server/spoken-inputs");
const { buildReviewPackage, toMarkdown } = require("../scripts/export-procedure-review");
const sources = new Set([...require("../../knowledge_base/verified_sources.json"), ...require("../../knowledge_base/project_sources.json")].map(s => s.id));
const registry = new ProcedureRegistry();
const turn = (agent, session, text) => agent.handleVoiceTurn({ session, recognized_text: text });

test("four field-specific drafts do not increase active or approved procedures", () => {
  assert.equal(registry.procedures.length, 1);
  assert.equal(registry.drafts.length, 4);
  assert.equal(registry.drafts.reduce((n,d) => n+d.steps.length, 0), 32);
  assert.equal(registry.drafts.reduce((n,d) => n+d.exception_routes.length, 0), 20);
  for (const d of registry.drafts) {
    assert(new ExperimentRegistry().list().some(e => e.experiment_id === d.experiment_id));
    assert.equal(registry.getForExperiment(d.experiment_id), null);
    assert.equal(d.approval.status, "NOT_REVIEWED");
    assert.equal(d.detail_policy.flight_execution_allowed, false);
    assert(d.steps.every(s => s.missing_details.length > 0));
  }
});

for (const draft of registry.drafts) {
  test(`${draft.procedure_id}: selection and overview remain explicit about expert review`, async () => {
    const agent = new AgentOrchestrator();
    const name = new ExperimentRegistry().list().find(e => e.experiment_id === draft.experiment_id).display_name;
    const selected = await turn(agent, agent.createSession(), `选择${name}`);
    assert.equal(selected.response_type, "EXPERIMENT_SELECTED");
    assert.match(selected.speech_text, /待专家审核/u);
    const overview = await turn(agent, selected.session, "查看流程草案");
    assert.equal(overview.response_type, "PROCEDURE_DRAFT_OVERVIEW");
    assert.match(overview.speech_text, /8个记录节点/u);
    assert.deepEqual(overview.session, selected.session);
    for (const text of ["开始流程", "开始真实实验", "继续", "确认无误", "专家已同意，恢复流程"]) {
      const blocked = await turn(agent, selected.session, text);
      assert.equal(blocked.response_type, "PROCEDURE_REVIEW_REQUIRED", text);
      assert.deepEqual(blocked.session, selected.session);
      assert.equal(blocked.session.procedure_id, null);
    }
  });
  test(`${draft.procedure_id}: direct engine calls cannot bypass the lock`, () => {
    const engine = new ProcedureEngine();
    const session = { session_id: "software-test-only", experiment_id: draft.experiment_id, status: "CONTEXT_SELECTED" };
    assert.equal(engine.start(session, draft).response_type, "PROCEDURE_REVIEW_REQUIRED");
    assert.deepEqual(engine.start(session, draft).session, session);
    assert.equal(engine.handleInput(session, draft, "确认无误").response_type, "PROCEDURE_REVIEW_REQUIRED");
  });
  test(`${draft.procedure_id}: review record fields parse without adding scientific pass limits`, () => {
    for (const step of draft.steps) {
      const expected = {};
      const report = step.required_inputs.map(f => {
        const value = f.type === "identifier" ? "REVIEW-001" : f.type === "datetime_utc" ? "2026-10-08T08:00:00Z"
          : f.type === "boolean" ? true : f.name === "ph" ? 7 : 22;
        expected[f.name] = value;
        return `${f.label}${value === true ? "已核对" : value}`;
      }).join("，");
      assert.deepEqual(extractStepInputs(step, report).values, expected, step.step_id);
      assert(step.validation_rules.every(r => ["present", "equals"].includes(r.operator)));
    }
  });
  test(`${draft.procedure_id}: exception proposals have traceability and no fabricated remedy`, () => {
    const publicRefs = require("../../knowledge_base/verified_sources.json");
    for (const route of draft.exception_routes) {
      assert(route.evidence_links.some(l => publicRefs.some(s => s.id === l.source_id && s.checked_on)));
      assert.equal(route.technical_remedy, null);
      assert.equal(route.remedy_approval_status, "NOT_REVIEWED");
      assert.match(route.spoken_alert, /保持暂停/u);
      assert(route.recovery_requirements.length >= 4);
    }
  });
}

test("a draft query mentioning another experiment preserves the active rice task", async () => {
  const agent = new AgentOrchestrator();
  const selected = await turn(agent, agent.createSession(), "选择水稻实验");
  const started = await turn(agent, selected.session, "开始流程");
  const query = await turn(agent, started.session, "查看蛋白质结晶流程草案");
  assert.equal(query.response_type, "PROCEDURE_DRAFT_OVERVIEW");
  assert.match(query.speech_text, /蛋白质结晶/u);
  assert.deepEqual(query.session, started.session);
});

test("source identity, boundaries and fake approvals are rejected at load time", () => {
  for (const mutate of [
    d => { d.approval.status = "APPROVED"; },
    d => { d.approval.reviewer = "claimed reviewer"; },
    d => { d.detail_policy.flight_execution_allowed = true; },
    d => { d.task_parameters[0].approved_value = 25; },
    d => { d.steps[0].source_refs.push("nonexistent-reference"); },
    d => { d.steps[0].evidence_links[0].source_id = "nonexistent-reference"; },
    d => { d.steps[2].validation_rules[0].operator = ">"; },
    d => { d.exception_routes[0].technical_remedy = "invented operation"; },
  ]) {
    const drafts = structuredClone(registry.drafts); mutate(drafts[0]);
    assert.throws(() => validateReviewDrafts(drafts, sources), /INVALID|NOT_APPROVED/u);
  }
});

test("review export is traceable, not submitted or approved, with partial scopes retained", () => {
  const pkg = buildReviewPackage();
  assert.equal(pkg.status, "PREPARED_FOR_EXTERNAL_EXPERT_REVIEW_NOT_SUBMITTED");
  assert.equal(pkg.expert_reviews_received, 0);
  assert.equal(pkg.summary.approved_procedures, 0);
  assert.equal(pkg.summary.public_source_inventory_count, 48);
  assert.equal(pkg.other_directory_items.length, 15);
  assert(pkg.drafts.every(d => /^[a-f0-9]{64}$/u.test(d.content_sha256)));
  const text = toMarkdown(pkg);
  assert.match(text, /微小动物/u); assert.match(text, /生化分子组装/u);
  assert.match(text, /技术处置：未提供/u);
  assert.match(text, /任务文件\/页码/u);
  assert(pkg.source_inventory.every(s => s && s.id));
});

test("listing experiments separates loaded demo from locked review drafts", async () => {
  const agent = new AgentOrchestrator();
  const result = await turn(agent, agent.createSession(), "有哪些实验");
  assert.match(result.speech_text, /1个演示或操作流程/u);
  assert.match(result.speech_text, /4套待审核草案/u);
});
