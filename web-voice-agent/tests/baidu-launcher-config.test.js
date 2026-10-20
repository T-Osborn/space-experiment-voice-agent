const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Baidu shortcut uses T's selected 2.0 voice 5 without embedding credentials", () => {
  const launcher = fs.readFileSync(path.join(__dirname, "../../Start-Baidu-Voice-Agent.cmd"), "utf8");
  assert.match(launcher, /-Provider baidu -BaiduTtsService short_text -BaiduVoiceId 5\s/u);
  assert.doesNotMatch(launcher, /set\s+"?BAIDU_TTS_|set\s*\/p/iu);
  assert.match(launcher, /^setlocal\r?$/mu);
  assert.match(launcher, /^endlocal\r?$/mu);
  assert.doesNotMatch(launcher, /set\s+"?BAIDU_(?:API_KEY|SECRET_KEY)=|setx\s|voice\/clone\/(?:create|delete)/iu);
});

test("local and deployment templates agree on 2.0 voice and contain no Baidu credentials", () => {
  for (const filename of [".env.example", ".env.deploy.example"]) {
    const template = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
    assert.match(template, /^BAIDU_TTS_SERVICE=short_text\r?$/mu);
    assert.match(template, /^BAIDU_TTS_VOICE=5\r?$/mu);
    assert.match(template, /^BAIDU_TTS_VOICE_NAME=度小娇（per 5）\r?$/mu);
    assert.match(template, /^BAIDU_API_KEY=\r?$/mu);
    assert.match(template, /^BAIDU_SECRET_KEY=\r?$/mu);
  }
});
