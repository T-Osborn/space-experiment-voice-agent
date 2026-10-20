const fs = require("node:fs");
const path = require("node:path");

const REGISTRY_PATH = path.join(__dirname, "..", "config", "experiments.json");

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[\s，。！？、,.!?]/g, "");
}

class ExperimentRegistry {
  constructor() {
    this.config = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    this.experiments = this.config.experiments || [];
  }

  list() {
    return this.experiments.map((experiment) => ({
      experiment_id: experiment.experiment_id,
      display_name: experiment.display_name,
      aliases: experiment.aliases,
      role: experiment.role,
      sop_status: experiment.sop_status,
      execution_policy: experiment.execution_policy,
      guidance_available: experiment.guidance_available === true,
    }));
  }

  resolve(query) {
    const normalizedQuery = normalize(query);
    let best = null;

    for (const experiment of this.experiments) {
      const candidates = [experiment.display_name, ...(experiment.aliases || [])]
        .map(normalize)
        .filter(Boolean);
      for (const candidate of candidates) {
        if (!normalizedQuery.includes(candidate)) continue;
        const score = candidate.length;
        if (!best || score > best.score) best = { experiment, score };
      }
    }

    return best?.experiment || null;
  }

  route(query, session, { allowSwitch = true } = {}) {
    const matched = this.resolve(query);
    const current = this.experiments.find((experiment) => experiment.experiment_id === session.experiment_id) || null;
    if (!allowSwitch) {
      return { kind: "REFERENCE", experiment: current, mentioned_experiment: matched, switched: false, session };
    }
    if (matched) {
      const switched = session.experiment_id !== matched.experiment_id;
      return {
        kind: "MATCHED",
        experiment: matched,
        switched,
        session: {
          ...session,
          experiment_id: matched.experiment_id,
          status: switched ? "CONTEXT_SELECTED" : session.status,
          current_step: switched ? null : session.current_step,
          ...(switched ? {
            procedure_id: null,
            procedure_version: null,
            step_state: null,
            step_observations: {},
            observations: {},
            pending_confirmation: null,
            completed_steps: [],
            step_records: {},
            pause_reason: null,
            paused_from_step_state: null,
            last_exception: null,
            unresolved_conflicts: [],
            pending_resume_basis: null,
            last_operator_feedback: null,
          } : {}),
        },
      };
    }

    const appearsToNameAnExperiment = /(实验|任务|SOP|流程|样品|取样)/u.test(query);
    const asksToSelectOrExecute = /(切换|选择|进入|开展|开始|执行|继续|下一步|使用)/u.test(query);
    if (appearsToNameAnExperiment && asksToSelectOrExecute && (!current || /(切换|选择|进入|使用)/u.test(query))) {
      return { kind: "UNREGISTERED", experiment: null, switched: false, session };
    }

    return { kind: "NONE", experiment: current, switched: false, session };
  }
}

module.exports = { ExperimentRegistry };
