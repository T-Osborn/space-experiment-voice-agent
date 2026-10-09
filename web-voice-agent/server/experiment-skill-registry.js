const fs = require("node:fs");
const path = require("node:path");

const SKILLS_PATH = path.join(__dirname, "..", "config", "experiment-skills.json");

class ExperimentSkillRegistry {
  constructor() {
    this.config = JSON.parse(fs.readFileSync(SKILLS_PATH, "utf8"));
    this.skills = this.config.skills || [];
  }

  getForExperiment(experimentId) {
    return this.skills.find((skill) => skill.experiment_id === experimentId) || null;
  }

  list() {
    return this.skills.map((skill) => ({
      skill_id: skill.skill_id,
      experiment_id: skill.experiment_id,
      version: skill.version,
      sop_status: skill.sop_status,
      execution_policy: skill.execution_policy,
    }));
  }
}

module.exports = { ExperimentSkillRegistry };
