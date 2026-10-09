const test = require("node:test");
const assert = require("node:assert/strict");
const { runRehearsal } = require("../scripts/rehearse-demo");

test("normal and exception demo rehearsals complete without speech credentials", async () => {
  const result = await runRehearsal();
  assert.equal(result.input_mode, "SIMULATED_ASR_TEXT");
  assert.equal(result.real_audio_verified, false);
  assert.equal(result.cloud_speech_called, false);
  assert.equal(result.scenarios.length, 4);
  assert.ok(result.scenarios.every((scenario) => scenario.final_status === "COMPLETED" && scenario.confirmed_steps === 9));
});
