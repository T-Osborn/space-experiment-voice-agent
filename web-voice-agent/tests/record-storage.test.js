const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { RecordRepository } = require("../server/record-repository");
const { SessionStore, DemoAccess, deploymentConfig } = require("../server/deployment-security");
const { backupRecords } = require("../scripts/backup-records");
const { riceReports } = require("../scripts/demo-inputs");

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, "voice-records-test-"));
  const repositories = [];
  t.after(() => {
    for (const repo of repositories) repo.close();
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith("voice-records-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, repo: (dir = directory) => {
    const repo = new RecordRepository({ directory: dir }); repositories.push(repo); return repo;
  } };
}
const update = saved => ({ session: { ...saved, status: "GUIDING", current_step: "fixture", step_observations: { fixture_value: 12 } }, speech_text: "测试报告已记录" });

test("current task, pending confirmation and retry receipt survive a closed database and memory TTL", async t => {
  const f = fixture(t); let clock = 0;
  const repo = f.repo(); const store = new SessionStore({ repository: repo, now: () => clock, ttl: 10 });
  const initial = store.create("owner-a", { status: "IDLE" });
  const options = { requestId: "persist-request-0001", expectedRevision: 0, text: "测试报告" };
  const result = await store.turn(initial.session_id, "owner-a", saved => ({ ...update(saved),
    session: { ...update(saved).session, step_state: "WAITING_STEP_CONFIRMATION", pending_confirmation: "fixture" },
  }), options);
  clock = 11;
  assert.deepEqual(store.get(initial.session_id, "owner-a").session, result.session);
  repo.close();
  const restarted = new SessionStore({ repository: f.repo() });
  assert.deepEqual(restarted.create("owner-a", {}), result.session);
  const replay = await restarted.turn(initial.session_id, "owner-a", () => { throw new Error("must not execute twice"); }, options);
  assert.deepEqual(replay, result);
  assert.throws(() => restarted.get(initial.session_id, "owner-b"), /NOT_FOUND/u);
});

test("a failed archive write rolls back the state update and never acknowledges a new step", async t => {
  const f = fixture(t); const repo = f.repo(); const store = new SessionStore({ repository: repo });
  const initial = store.create("owner-a", { status: "IDLE" });
  repo.db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON archives BEGIN SELECT RAISE(FAIL,'fixture disk write failure'); END");
  await assert.rejects(store.turn(initial.session_id, "owner-a", saved => ({ ...update(saved),
    record_export: { data: { session: saved } },
  })), /RECORD_STORAGE_UNAVAILABLE/u);
  assert.deepEqual(store.get(initial.session_id, "owner-a").session, initial);
  assert.equal(repo.history("owner-a").length, 0);
});

test("two running instances cannot overwrite a newer committed revision", async t => {
  const f = fixture(t);
  const first = new SessionStore({ repository: f.repo() });
  const second = new SessionStore({ repository: f.repo() });
  const initial = first.create("owner-a", { status: "IDLE" });
  let finish;
  const delayed = first.turn(initial.session_id, "owner-a", saved => new Promise(resolve => {
    finish = () => resolve(update(saved));
  }));
  const committed = await second.turn(initial.session_id, "owner-a", saved => ({ session: { ...saved, status: "PAUSED" } }));
  finish();
  await assert.rejects(delayed, /SESSION_REVISION_CONFLICT/u);
  assert.deepEqual(first.get(initial.session_id, "owner-a").session, committed.session);
});

test("corrupt saved JSON is reported without replacing the user's task", t => {
  const f = fixture(t); const repo = f.repo(); const store = new SessionStore({ repository: repo });
  const initial = store.create("owner-a", { status: "IDLE" });
  repo.db.prepare("UPDATE sessions SET body=? WHERE id=?").run("BROKEN_JSON_FIXTURE", initial.session_id);
  assert.throws(() => new SessionStore({ repository: repo }).create("owner-a", {}), /RECORD_STORAGE_CORRUPT/u);
  assert.equal(repo.db.prepare("SELECT body FROM sessions WHERE id=?").get(initial.session_id).body, "BROKEN_JSON_FIXTURE");
});

test("an invalid SQLite file and unknown schema fail without silently recreating the data", t => {
  const f = fixture(t); const file = path.join(f.directory, "records.sqlite");
  fs.writeFileSync(file, "BROKEN_SQLITE_FIXTURE");
  assert.throws(() => f.repo(), /RECORD_STORAGE_/u);
  assert.equal(fs.readFileSync(file, "utf8"), "BROKEN_SQLITE_FIXTURE");
  const futureDirectory = path.join(f.directory, "future"); fs.mkdirSync(futureDirectory);
  const db = new DatabaseSync(path.join(futureDirectory, "records.sqlite"));
  db.exec("PRAGMA user_version=99"); db.close();
  assert.throws(() => f.repo(futureDirectory), /VERSION_UNSUPPORTED/u);
});

test("archives retain the previous task and enforce the same owner boundary as live sessions", async t => {
  const f = fixture(t); const repo = f.repo(); const store = new SessionStore({ repository: repo });
  const initial = store.create("owner-a", { status: "COMPLETED", completed_steps: ["fixture-step"], experiment_id: "fixture-experiment" });
  await store.turn(initial.session_id, "owner-a", saved => ({ session: { session_id: saved.session_id, status: "IDLE" },
    record_export: { data: { session: saved, record_kind: "OPERATOR_REPORTED_DEMO_RECORD" } },
  }));
  const records = repo.history("owner-a");
  assert.equal(records.length, 1); assert.equal(records[0].completed_steps, 1);
  assert.equal(repo.archive(records[0].id, "owner-a").session.status, "COMPLETED");
  assert.deepEqual(repo.history("owner-b"), []);
  assert.throws(() => repo.archive(records[0].id, "owner-b"), /RECORD_NOT_FOUND/u);
  repo.close();
  assert.equal(f.repo().history("owner-a")[0].id, records[0].id);
});

test("online backup is readable and preserves committed state without changing the live database", async t => {
  const f = fixture(t); const repo = f.repo(); const store = new SessionStore({ repository: repo });
  const initial = store.create("owner-a", { status: "IDLE" });
  const changed = await store.turn(initial.session_id, "owner-a", update);
  const result = await backupRecords(f.directory);
  assert.equal(result.verified, true); assert.equal(result.cloud_requests, false);
  const restored = new SessionStore({ repository: f.repo(path.dirname(result.backup_file)) });
  assert.deepEqual(restored.create("owner-a", {}), changed.session);
  assert.deepEqual(store.get(initial.session_id, "owner-a").session, changed.session);
  const again = await backupRecords(f.directory);
  assert.notEqual(result.backup_file, again.backup_file);
  assert.ok(fs.existsSync(result.backup_file));
});

test("durable browser identity is hashed and does not bypass production reauthorization after restart", () => {
  const token = "production-fixture-only-not-a-real-token";
  const config = deploymentConfig({ APP_ENV: "production", PUBLIC_ORIGIN: "https://demo.example", DEPLOY_ACCESS_TOKEN: token });
  const req = { headers: {}, socket: { remoteAddress: "fixture-client" } };
  let header;
  const res = { setHeader: (name, value) => { if (name === "Set-Cookie") header = value; } };
  const before = new DemoAccess(config, { persistentIdentity: true });
  before.grant(req, res, token);
  req.headers.cookie = header.split(";")[0];
  assert.match(header, /Max-Age=15552000; Secure/u);
  const owner = before.owner(req);
  assert.notEqual(owner, req.headers.cookie.split("=")[1]);
  const after = new DemoAccess(config, { persistentIdentity: true });
  assert.throws(() => after.owner(req), /DEMO_ACCESS_REQUIRED/u);
  assert.throws(() => after.grant(req, res, "wrong"), /DEMO_ACCESS_REQUIRED/u);
  after.grant(req, res, token);
  assert.equal(after.owner(req), owner);
});

async function unusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function startProcess(directory) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [path.join(__dirname, "../server/index.js")], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", APP_ENV: "development", PUBLIC_ORIGIN: "", DEPLOY_ACCESS_TOKEN: "",
      RECORD_STORAGE: "sqlite", RECORD_DATA_DIR: directory, ASR_PROVIDER: "generic_http", ASR_UPSTREAM_URL: "",
      TTS_PROVIDER: "none", SEMANTIC_PROVIDER: "none", OPENAI_API_KEY: "", BAIDU_API_KEY: "", BAIDU_SECRET_KEY: "" },
  });
  child.stdout.resume(); child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  } };
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("PERSISTENT_TEST_SERVER_EXITED");
      try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(200) })).ok) return { base, stop }; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("PERSISTENT_TEST_SERVER_TIMEOUT");
  } catch (error) { await stop(); throw error; }
}

test("real server process restart restores the same browser's task, retry receipt and private archive links", async t => {
  const f = fixture(t); let running = await startProcess(f.directory);
  let cookie = "";
  const request = (route, body, selectedCookie = cookie) => fetch(running.base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: selectedCookie, "X-Voice-Agent-Request": "1", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    let access = await request("/api/access", {}); cookie = access.headers.get("set-cookie").split(";")[0];
    let state = await (await request("/api/session", {})).json();
    let sequence = 0;
    const payload = text => ({ session_id: state.session_id, recognized_text: text, expected_revision: state.revision, request_id: `persistent-turn-${sequence++}` });
    async function voice(text) {
      const response = await request("/api/voice/turn", payload(text)); assert.equal(response.status, 200);
      const result = await response.json(); state = result.session; return result;
    }
    await voice("选择太空水稻实验"); await voice("开始流程");
    const lostResponsePayload = payload(riceReports[0]);
    const pending = await (await request("/api/voice/turn", lostResponsePayload)).json();
    state = pending.session;
    assert.equal(state.step_state, "WAITING_STEP_CONFIRMATION");
    await running.stop(); running = await startProcess(f.directory);
    access = await request("/api/access", {}); assert.equal(access.status, 200);
    assert.equal(access.headers.get("set-cookie").split(";")[0], cookie);
    const restored = await (await request("/api/session", {})).json();
    assert.deepEqual(restored, state);
    const replay = await (await request("/api/voice/turn", lostResponsePayload)).json();
    assert.deepEqual(replay, pending);
    await voice("确认无误"); assert.equal(state.completed_steps.length, 1);
    await voice("重新开始"); await voice("确认重新开始");
    assert.equal(state.completed_steps.length, 0);
    const beforeHistory = structuredClone(state);
    const history = await voice("查看历史记录");
    assert.equal(history.record_history.length, 1);
    assert.equal(history.record_history[0].completed_steps, 1);
    const { revision: newRevision, ...newState } = state;
    const { revision: oldRevision, ...oldState } = beforeHistory;
    assert.equal(newRevision, oldRevision + 1); assert.deepEqual(newState, oldState);
    const download = await request(history.record_history[0].download_url);
    assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition"), /attachment/u);
    assert.equal((await download.json()).session.completed_steps.length, 1);
    const strangerAccess = await request("/api/access", {}, "");
    const strangerCookie = strangerAccess.headers.get("set-cookie").split(";")[0];
    assert.equal((await request(history.record_history[0].download_url, undefined, strangerCookie)).status, 404);
    assert.deepEqual((await (await request("/api/records", undefined, strangerCookie)).json()).records, []);
    const caps = await (await request("/api/capabilities")).json();
    assert.equal(caps.session_storage, "SQLITE"); assert.equal(caps.restart_recovery, true);
    // A persisted last reply cannot repeat an instruction from a different procedure version.
    const inspect = f.repo();
    const row = inspect.db.prepare("SELECT body FROM sessions WHERE id=?").get(state.session_id);
    const saved = JSON.parse(row.body);
    saved.session.procedure_version = "outdated-fixture-version";
    saved.lastReply.speech_text = "OUTDATED_INSTRUCTION_FIXTURE";
    inspect.db.prepare("UPDATE sessions SET body=? WHERE id=?").run(JSON.stringify(saved), state.session_id);
    const repeated = await voice("再说一遍");
    assert.equal(repeated.response_type, "PROCEDURE_VERSION_MISMATCH");
    assert.equal(repeated.session.status, "PAUSED");
    assert.doesNotMatch(repeated.speech_text, /OUTDATED_INSTRUCTION/u);
  } finally { await running.stop(); }
});
