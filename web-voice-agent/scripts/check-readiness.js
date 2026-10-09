const path = require("node:path");
const { loadEnvFile } = require("../server/env-loader");
const { ASRAdapterRegistry } = require("../server/asr-adapters");
const { TTSAdapterRegistry } = require("../server/tts-adapters");
const { ProcedureRegistry } = require("../server/procedure-registry");
const { summarizeReadiness } = require("../server/readiness");

function checkReadiness() {
  loadEnvFile(path.join(__dirname, "..", ".env"));
  const procedures = new ProcedureRegistry();
  return summarizeReadiness({
    asr: new ASRAdapterRegistry().getPublicConfig(), tts: new TTSAdapterRegistry().getPublicConfig(),
    demoProcedureAvailable: procedures.procedures.some(p => p.guidance_mode === "PROJECT_DEMO" || p.sop_status === "APPROVED"),
  });
}

if (require.main === module) {
  try {
    const json = JSON.stringify(checkReadiness(), null, 2);
    // Powershell may decode native output using the CMD code page instead of UTF-8.
    // JSON Unicode escapes preserve all labels without changing the console encoding.
    const output = process.argv.includes("--ascii")
      ? json.replace(/[\u007f-\uffff]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"))
      : json;
    process.stdout.write(output + "\n");
  }
  catch { process.stderr.write("READINESS_CHECK_FAILED\n"); process.exitCode = 1; }
}

module.exports = { checkReadiness };
