const fs = require("node:fs");
const path = require("node:path");
const { buildReviewDrafts } = require("../config/procedure-review-drafts");

const PROCEDURES_PATH = path.join(__dirname, "..", "config", "procedure-guides.json");

class ProcedureRegistry {
  constructor({ config, drafts } = {}) {
    this.config = config || JSON.parse(fs.readFileSync(PROCEDURES_PATH, "utf8"));
    this.procedures = this.config.procedures || [];
    const kb = path.join(__dirname, "../../knowledge_base");
    const sources = ["project_sources.json", "verified_sources.json"].flatMap((file) => JSON.parse(fs.readFileSync(path.join(kb, file), "utf8")));
    const sourceIds = new Set(sources.map((source) => source.id));
    validateProcedures(this.procedures, sourceIds);
    this.drafts = drafts || buildReviewDrafts();
    validateReviewDrafts(this.drafts, sourceIds);
    if (this.drafts.some((draft) => this.procedures.some((p) => p.procedure_id === draft.procedure_id
      || p.experiment_id === draft.experiment_id))) throw new Error("REVIEW_DRAFT_OVERLAPS_ACTIVE_PROCEDURE");
  }

  getForExperiment(experimentId) {
    return this.procedures.find((procedure) => procedure.experiment_id === experimentId) || null;
  }

  getDraftForExperiment(experimentId) {
    return this.drafts.find((draft) => draft.experiment_id === experimentId) || null;
  }

  listDrafts() {
    return this.drafts.map((draft) => ({
      procedure_id: draft.procedure_id, experiment_id: draft.experiment_id,
      display_name: draft.display_name, version: draft.version, sop_status: draft.sop_status,
      guidance_mode: draft.guidance_mode, review_status: draft.approval.status,
      step_count: draft.steps.length, exception_route_count: draft.exception_routes.length,
      missing_detail_count: draft.steps.reduce((n, s) => n + s.missing_details.length, 0),
      flight_execution_allowed: false, guidance_available: false,
      scope_note: draft.scope_note, reviewer_roles: draft.reviewer_roles,
      steps: draft.steps.map((s) => ({ step_id: s.step_id, sequence: s.sequence, name: s.name })),
    }));
  }

  list() {
    return this.procedures.map((procedure) => ({
      procedure_id: procedure.procedure_id,
      experiment_id: procedure.experiment_id,
      version: procedure.version,
      sop_status: procedure.sop_status,
      guidance_mode: procedure.guidance_mode,
      step_count: procedure.steps?.length || 0,
      missing_detail_count: procedure.steps.reduce((sum, step) => sum + (step.missing_details?.length || 0), 0),
      flight_execution_allowed: procedure.sop_status === "APPROVED" && procedure.detail_policy?.flight_execution_allowed === true,
    }));
  }
}

function validateReviewDrafts(drafts, sourceIds) {
  validateProcedures(drafts, sourceIds);
  for (const draft of drafts) {
    if (draft.guidance_mode !== "EXPERT_REVIEW_DRAFT" || draft.sop_status !== "EXPERT_REVIEW_PENDING"
      || draft.execution_policy !== "BLOCK_UNTIL_TASK_SOP_AND_EXPERT_REVIEW"
      || draft.detail_policy?.flight_execution_allowed !== false
      || draft.detail_policy?.hardware_actions_allowed !== false
      || draft.detail_policy?.numerical_pass_limits_available !== false
      || draft.approval?.status !== "NOT_REVIEWED" || draft.approval.reviewer !== null
      || draft.approval.signed_document_reference !== null || !draft.reviewer_roles?.length
      || !draft.mandatory_review_checks?.length || !draft.task_parameters?.length
      || draft.task_parameters.some((p) => p.approved_value !== null || p.approved_rule !== null
        || p.authority_reference !== null || !p.reviewer_question)) throw new Error("REVIEW_DRAFT_POLICY_INVALID");
    const routeIds = new Set();
    for (const route of draft.exception_routes || []) {
      if (!route.route_id || routeIds.has(route.route_id) || !route.trigger_examples?.length
        || !route.collect?.length || !route.forbidden_actions?.length || !route.recovery_requirements?.length
        || !route.spoken_alert || route.technical_remedy !== null || route.remedy_approval_status !== "NOT_REVIEWED"
        || !route.source_refs?.length || route.source_refs.some((id) => !sourceIds.has(id))) throw new Error("REVIEW_EXCEPTION_INVALID");
      routeIds.add(route.route_id);
    }
    if (!routeIds.size) throw new Error("REVIEW_EXCEPTION_INVALID");
    for (const item of [...draft.steps, ...draft.exception_routes]) {
      if (!item.evidence_links?.length || item.evidence_links.some((link) => !sourceIds.has(link.source_id)
        || !item.source_refs.includes(link.source_id) || !["TOPIC", "ANALOGUE"].includes(link.relation)
        || !link.supports || !link.does_not_support)) throw new Error("REVIEW_EVIDENCE_INVALID");
    }
    for (const s of draft.steps) {
      if (!s.missing_details?.length || s.validation_rules.some((r) => !["present", "equals"].includes(r.operator))) {
        throw new Error("REVIEW_DRAFT_THRESHOLD_NOT_APPROVED");
      }
    }
  }
}

function validateProcedures(procedures, sourceIds) {
  const ids = new Set(); const experiments = new Set();
  for (const procedure of procedures) {
    if (!procedure.procedure_id || !procedure.experiment_id || !procedure.version || ids.has(procedure.procedure_id)
      || experiments.has(procedure.experiment_id) || !procedure.steps?.length) throw new Error("PROCEDURE_SCHEMA_INVALID");
    ids.add(procedure.procedure_id); experiments.add(procedure.experiment_id);
    const stepIds = new Set();
    for (const [index, step] of procedure.steps.entries()) {
      if (!step.step_id || stepIds.has(step.step_id) || step.sequence !== index + 1
        || step.next_step !== (procedure.steps[index + 1]?.step_id || null)
        || !step.spoken_instruction || !step.required_inputs?.length || !step.validation_rules?.length
        || !step.source_refs?.length || step.source_refs.some((id) => !sourceIds.has(id))) throw new Error("PROCEDURE_STEP_INVALID");
      stepIds.add(step.step_id);
      const fields = new Set();
      for (const input of step.required_inputs) {
        if (!input.name || !input.label || fields.has(input.name) || !input.aliases?.length
          || !["number", "boolean", "enum", "identifier", "datetime_utc"].includes(input.type)
          || (input.type === "enum" && !Object.keys(input.options || {}).length)) throw new Error("PROCEDURE_INPUT_INVALID");
        fields.add(input.name);
      }
      function checkRule(rule) {
        if (rule.all || rule.any) return (rule.all || rule.any).length > 0 && (rule.all || rule.any).every(checkRule);
        return fields.has(rule.field) && ["equals", "present", ">", ">=", "<", "<="].includes(rule.operator);
      }
      if (!step.validation_rules.every(checkRule)) throw new Error("PROCEDURE_RULE_INVALID");
    }
  }
}

module.exports = { ProcedureRegistry, validateProcedures, validateReviewDrafts };
