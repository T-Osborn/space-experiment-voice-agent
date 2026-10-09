const path = require("node:path");
const { loadEnvFile } = require("../server/env-loader");
const { deploymentConfig } = require("../server/deployment-security");
loadEnvFile(path.join(__dirname, "..", ".env"));
try {
  const config = deploymentConfig();
  process.stdout.write(JSON.stringify({
    configuration_valid: true,
    mode: config.production ? "RESTRICTED_DEMO" : "LOCAL_DEMO",
    host: config.host, public_origin: config.origin,
    access_token_configured: !!config.token,
    https_endpoint_verified: false, container_build_verified: false,
    microphone_verified: false, flight_ready: false,
    note: "仅检查启动配置，不检查真实部署、语音或任务SOP。",
  }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(/^[A-Z0-9_]+$/u.test(error.message) ? error.message + "\n" : "CONFIG_INVALID\n");
  process.exitCode = 1;
}
