const fs = require("node:fs");
const path = require("node:path");

const policy = Object.freeze(JSON.parse(fs.readFileSync(path.join(__dirname, "../config/behavior-policy.json"), "utf8")));
// These are the supported V2 rules, not switches for bypassing task validation.
for (const name of ["knowledge_queries_preserve_task", "combine_missing_input_questions", "validate_explicit_units",
  "independent_readback_confirmation", "abnormal_resume_requires_configured_authority", "required_knowledge_retrieval"]) {
  if (policy[name] !== true) throw new Error("BEHAVIOR_POLICY_UNSUPPORTED");
}
if (policy.ordinary_pause_requires_ground_instruction !== false) throw new Error("BEHAVIOR_POLICY_UNSUPPORTED");
if (policy.prompt_document !== "system-prompt-v2.md" || !policy.clarification_prefix) throw new Error("BEHAVIOR_POLICY_UNSUPPORTED");
const systemPrompt = fs.readFileSync(path.join(__dirname, "../config", policy.prompt_document), "utf8");
if (!systemPrompt.trim()) throw new Error("SYSTEM_PROMPT_REQUIRED");

module.exports = { behaviorPolicy: policy, systemPrompt };
