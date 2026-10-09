const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.join(__dirname, "..");
const tests = path.join(root, "tests");
if (!fs.existsSync(tests)) {
  process.stderr.write("TEST_SOURCES_NOT_PACKAGED: 部署包不含完整测试资料，请在原项目运行回归测试。\n");
  process.exitCode = 1;
} else {
  const files = fs.readdirSync(tests).filter((name) => name.endsWith(".test.js")).map((name) => path.join(tests, name));
  if (!files.length) { process.stderr.write("NO_TESTS_FOUND\n"); process.exitCode = 1; }
  else process.exitCode = spawnSync(process.execPath, ["--test", ...files], {
    cwd: root, stdio: "inherit",
    // Test fixtures must never accidentally activate a real semantic provider.
    env: { ...process.env, SEMANTIC_PROVIDER: "none", SEMANTIC_API_KEY: "", SEMANTIC_MODEL: "" },
  }).status ?? 1;
}
