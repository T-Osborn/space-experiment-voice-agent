const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Baidu shortcut uses T's selected voice 4100 without embedding credentials", () => {
  const launcher = fs.readFileSync(path.join(__dirname, "../../Start-Baidu-Voice-Agent.cmd"), "utf8");
  assert.match(launcher, /-Provider baidu -BaiduTtsService short_text -BaiduVoiceId 4100/u);
  assert.doesNotMatch(launcher, /set\s+"?BAIDU_TTS_|set\s*\/p/iu);
  assert.match(launcher, /^setlocal\r?$/mu);
  assert.match(launcher, /^endlocal\r?$/mu);
  assert.doesNotMatch(launcher, /set\s+"?BAIDU_(?:API_KEY|SECRET_KEY)=|setx\s|voice\/clone\/(?:create|delete)/iu);
});
