const test = require("node:test");
const assert = require("node:assert/strict");
const { request, voiceTurn } = require("../public/voice-network");

test("voice command transport retries the exact same request after a lost response", async () => {
  const original = global.fetch;
  const bodies = [];
  try {
    global.fetch = async (url, options) => {
      bodies.push(options.body);
      if (bodies.length === 1) throw new TypeError("fixture lost response");
      return { ok: true, status: 200, json: async () => ({ session: { revision: 1 } }) };
    };
    const result = await voiceTurn({ session_id: "test", request_id: "fixed-id-123456789", expected_revision: 0, recognized_text: "确认无误" });
    assert.equal(result.data.session.revision, 1);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
  } finally { global.fetch = original; }
});

test("request deadline includes body reading; state conflicts are not automatically resubmitted", async () => {
  const original = global.fetch;
  try {
    global.fetch = async (url, options) => ({ ok: true, status: 200, json: () => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("fixture aborted")), { once: true });
    }) });
    await assert.rejects(request("/fixture", {}, { timeoutMs: 10 }), /REQUEST_TIMEOUT/u);
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 409, json: async () => ({ error: "SESSION_REVISION_CONFLICT" }) }; };
    assert.equal((await voiceTurn({})).status, 409);
    assert.equal(calls, 1);
  } finally { global.fetch = original; }
});
