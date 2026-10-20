const test = require("node:test");
const assert = require("node:assert/strict");
const { runRehearsal } = require("../scripts/rehearse-demo");

test("normal demos complete and V2 exception demos preserve their paused records without speech credentials", async () => {
  const result = await runRehearsal();
  assert.equal(result.input_mode, "SIMULATED_ASR_TEXT");
  assert.equal(result.real_audio_verified, false);
  assert.equal(result.cloud_speech_called, false);
  assert.equal(result.scenarios.length, 4);
  assert.equal(result.scenarios.filter(scenario => scenario.final_status === "COMPLETED" && scenario.confirmed_steps === 9).length, 2);
  assert.equal(result.scenarios.find(scenario => scenario.name.startsWith("exception_holds")).final_status, "PAUSED");
  assert.equal(result.scenarios.find(scenario => scenario.name.startsWith("identity_exception")).final_status, "EXCEPTION_REPORTED");
});
