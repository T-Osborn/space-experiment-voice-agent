const { randomBytes, timingSafeEqual, createHash } = require("node:crypto");

function failure(code, status = 400) { return Object.assign(new Error(code), { status }); }

function deploymentConfig(env = process.env) {
  const production = env.APP_ENV === "production";
  const host = env.HOST || (production ? "0.0.0.0" : "127.0.0.1");
  if (!production && !["127.0.0.1", "localhost", "::1"].includes(host)) throw failure("DEV_HOST_MUST_BE_LOOPBACK");
  let origin = null;
  if (env.PUBLIC_ORIGIN) {
    try {
      const url = new URL(env.PUBLIC_ORIGIN);
      if (url.origin !== env.PUBLIC_ORIGIN || url.username || url.password) throw new Error();
      origin = url.origin;
    } catch { throw failure("PUBLIC_ORIGIN_INVALID"); }
  }
  if (production && (!origin || !origin.startsWith("https://"))) throw failure("PRODUCTION_HTTPS_ORIGIN_REQUIRED");
  const token = env.DEPLOY_ACCESS_TOKEN || "";
  if (production && (token.length < 32 || token.length > 256 || /\s/u.test(token))) throw failure("DEPLOY_ACCESS_TOKEN_REQUIRED");
  return { production, host, origin, token };
}

function cookieValue(req, name) {
  return String(req.headers.cookie || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

function assertSameOrigin(req, config) {
  if (req.headers["x-voice-agent-request"] !== "1") throw failure("REQUEST_HEADER_REQUIRED", 403);
  if (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])) throw failure("ORIGIN_REJECTED", 403);
  const origin = req.headers.origin;
  if (!origin) return; // Non-browser tools need the custom header AND the owner cookie/token.
  const expected = config.origin || `http://${req.headers.host}`;
  if (origin !== expected) throw failure("ORIGIN_REJECTED", 403);
  if (!config.production && !config.origin) {
    try { if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(expected).hostname)) throw new Error(); }
    catch { throw failure("ORIGIN_REJECTED", 403); }
  }
}

class DemoAccess {
  constructor(config, { now = Date.now, maxOwners = 128, ownerTTL = 3600000, requestLimit = 90, persistentIdentity = false } = {}) {
    this.config = config; this.now = now; this.maxOwners = maxOwners;
    this.ownerTTL = ownerTTL; this.requestLimit = requestLimit;
    this.persistentIdentity = persistentIdentity;
    this.owners = new Map(); this.accessRates = new Map();
  }
  prune() {
    const now = this.now();
    for (const [id, value] of this.owners) if (value.expires <= now) this.owners.delete(id);
    for (const [id, value] of this.accessRates) if (value.until <= now) this.accessRates.delete(id);
  }
  rate(map, key, limit) {
    const now = this.now();
    let bucket = map.get(key);
    if (!bucket || bucket.until <= now) {
      if (!bucket && map.size >= 1024) throw failure("SERVER_CAPACITY_REACHED", 503);
      bucket = { count: 0, until: now + 60000 }; map.set(key, bucket);
    }
    if (++bucket.count > limit) throw failure("RATE_LIMITED", 429);
  }
  owner(req) {
    this.prune();
    const id = this.identity(cookieValue(req, "va_owner"));
    if (!this.owners.has(id)) throw failure("DEMO_ACCESS_REQUIRED", 401);
    return id;
  }
  grant(req, res, suppliedToken) {
    this.prune();
    this.rate(this.accessRates, req.socket.remoteAddress || "unknown", 20);
    const existingCookie = cookieValue(req, "va_owner");
    const existing = this.identity(existingCookie);
    if (this.owners.has(existing)) return existing;
    if (this.config.production) {
      const supplied = Buffer.from(typeof suppliedToken === "string" ? suppliedToken : "");
      const expected = Buffer.from(this.config.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw failure("DEMO_ACCESS_REQUIRED", 401);
    }
    if (this.owners.size >= this.maxOwners) throw failure("SERVER_CAPACITY_REACHED", 503);
    // Durable identity survives restart; production authorization is still required above.
    const cookie = this.persistentIdentity && /^[a-f0-9]{64}$/u.test(existingCookie)
      ? existingCookie : randomBytes(32).toString("hex");
    const id = this.identity(cookie);
    this.owners.set(id, { expires: this.now() + this.ownerTTL, requests: new Map() });
    const cookieAge = this.persistentIdentity ? 180 * 24 * 3600 : Math.floor(this.ownerTTL / 1000);
    res.setHeader("Set-Cookie", `va_owner=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${cookieAge}${this.config.production ? "; Secure" : ""}`);
    return id;
  }
  identity(cookie) { return this.persistentIdentity ? createHash("sha256").update(cookie).digest("hex") : cookie; }
  checkRate(owner) { this.rate(this.owners.get(owner).requests, "api", this.requestLimit); }
}

class SessionStore {
  constructor({ now = Date.now, ttl = 3600000, maxSessions = 256, repository = null } = {}) {
    this.now = now; this.ttl = ttl; this.maxSessions = maxSessions; this.sessions = new Map();
    this.repository = repository;
  }
  prune() { for (const [id, entry] of this.sessions) if (!entry.busy && entry.expires <= this.now()) this.sessions.delete(id); }
  get(id, owner) {
    this.prune();
    let entry = this.sessions.get(id);
    if (this.repository && !entry?.busy) {
      const saved = this.repository.load(id, owner);
      entry = saved ? this.restore(saved) : null;
    }
    if (!entry || entry.owner !== owner) throw failure("SESSION_NOT_FOUND_OR_EXPIRED", 404);
    return entry;
  }
  create(owner, initial) {
    this.prune();
    const previous = [...this.sessions.values()].find((entry) => entry.owner === owner);
    if (previous) return structuredClone(this.get(previous.session.session_id, owner).session);
    if (this.repository) {
      const saved = this.repository.forOwner(owner);
      if (saved) return structuredClone(this.restore(saved).session);
    }
    if (this.sessions.size >= this.maxSessions) throw failure("SERVER_CAPACITY_REACHED", 503);
    const session = { ...initial, session_id: `session_${randomBytes(24).toString("hex")}`, revision: 0 };
    const entry = { owner, session, expires: this.now() + this.ttl, busy: false, receipts: new Map() };
    if (this.repository) entry.savedAt = this.repository.save(entry);
    this.sessions.set(session.session_id, entry);
    return structuredClone(session);
  }
  restore(saved) {
    const id = saved.session.session_id;
    if (!this.sessions.has(id) && this.sessions.size >= this.maxSessions) throw failure("SERVER_CAPACITY_REACHED", 503);
    const entry = { ...saved, receipts: new Map(saved.receipts), busy: false, expires: this.now() + this.ttl };
    this.sessions.set(id, entry);
    return entry;
  }
  async turn(id, owner, handler, { requestId, expectedRevision, text, repeatLast = false } = {}) {
    const entry = this.get(id, owner);
    const fingerprint = createHash("sha256").update(JSON.stringify([expectedRevision, text])).digest("hex");
    if (requestId && entry.receipts.has(requestId)) {
      const receipt = entry.receipts.get(requestId);
      if (receipt.fingerprint !== fingerprint) throw failure("TURN_ID_REUSED", 409);
      if (receipt.result.session.revision !== entry.session.revision) throw failure("TURN_SUPERSEDED", 409);
      return structuredClone(receipt.result);
    }
    if (entry.busy) throw failure("SESSION_BUSY", 409);
    if (expectedRevision !== undefined && expectedRevision !== entry.session.revision) throw failure("SESSION_REVISION_CONFLICT", 409);
    entry.busy = true;
    try {
      const result = repeatLast && entry.lastReply
        ? { ...structuredClone(entry.lastReply), session: structuredClone(entry.session), response_type: "GUIDANCE_REPEATED" }
        : await handler(structuredClone(entry.session));
      if (result.session?.session_id !== id) throw failure("SESSION_STATE_INVALID", 500);
      result.session.revision = entry.session.revision + 1;
      // Bound prototype demo history. Long-term mission records need a reviewed durable store.
      const log = result.session.event_log || [];
      if (log.length > 500) {
        result.session.event_log = log.slice(-500);
        result.session.event_log_truncated = true;
      }
      const next = { ...entry, session: structuredClone(result.session), expires: this.now() + this.ttl, receipts: new Map(entry.receipts) };
      if (result.speech_text) {
        const { session: ignoredSession, record_export: ignoredExport, ...reply } = result;
        next.lastReply = structuredClone(reply);
      }
      if (requestId) {
        next.receipts.set(requestId, { fingerprint, result: structuredClone(result) });
        if (next.receipts.size > 8) next.receipts.delete(next.receipts.keys().next().value);
      }
      // Commit before publishing the new in-memory state or acknowledging success.
      if (this.repository) next.savedAt = this.repository.save(next, {
        expectedRevision: entry.session.revision, archive: result.record_export?.data || null,
      });
      Object.assign(entry, next);
      return result;
    } finally { entry.busy = false; }
  }
}

function setSecurityHeaders(res, config) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  if (config.production) res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

module.exports = { deploymentConfig, DemoAccess, SessionStore, assertSameOrigin, setSecurityHeaders, failure };
