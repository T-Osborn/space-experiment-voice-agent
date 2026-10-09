const path = require("node:path");
const { loadEnvFile } = require("./env-loader");
const { deploymentConfig } = require("./deployment-security");
const { createApp } = require("./app-server");
const { DemoAccess, SessionStore } = require("./deployment-security");
const { RecordRepository, recordDirectory } = require("./record-repository");

loadEnvFile(path.join(__dirname, "..", ".env"));
let repository;
try {
  const config = deploymentConfig();
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT_INVALID");
  const mode = process.env.RECORD_STORAGE || "sqlite";
  if (!["sqlite", "memory"].includes(mode)) throw new Error("RECORD_STORAGE_CONFIG_INVALID");
  if (mode === "sqlite") repository = new RecordRepository({ directory: recordDirectory() });
  const { server } = createApp({ config,
    access: new DemoAccess(config, { persistentIdentity: Boolean(repository) }),
    sessions: new SessionStore({ repository }),
  });
  server.once("close", () => repository?.close());
  server.once("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? "PORT_IN_USE" : "SERVER_START_FAILED");
    repository?.close();
    process.exitCode = 1;
  });
  server.listen(port, config.host, () => {
    console.log("Voice-Agent listening on http://" + config.host + ":" + port);
    console.log(config.production ? "Restricted demo; HTTPS reverse proxy required." : "Local demo only; voice credentials may remain unset.");
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
  });
} catch (error) {
  repository?.close();
  console.error(/^[A-Z0-9_]+$/u.test(error.message) ? error.message : "SERVER_START_FAILED");
  process.exitCode = 1;
}
