const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function storageError(code = "RECORD_STORAGE_UNAVAILABLE", status = 503) {
  return Object.assign(new Error(code), { status });
}
function safeStorageError(error) {
  return error?.status ? error : storageError();
}
function recordDirectory(env = process.env) {
  return path.resolve(env.RECORD_DATA_DIR || path.join(__dirname, "../data"));
}

class RecordRepository {
  constructor({ directory = recordDirectory(), now = Date.now } = {}) {
    this.now = now;
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, "records.sqlite");
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(this.file, { timeout: 5000 });
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 1].includes(version)) throw storageError("RECORD_STORAGE_VERSION_UNSUPPORTED");
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw storageError("RECORD_STORAGE_CORRUPT");
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
          body TEXT NOT NULL, saved_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS archives (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL,
          revision INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS archive_owner ON archives(owner, created_at DESC);
        PRAGMA user_version=1;`);
    } catch (error) {
      try { this.db?.close(); } catch { /* preserve the original failure */ }
      this.db = null;
      throw safeStorageError(error);
    }
  }

  decode(row) {
    if (!row) return null;
    try {
      const data = JSON.parse(row.body);
      if (!data?.session || data.session.session_id !== row.id || data.session.revision !== row.revision
        || !Array.isArray(data.receipts) || data.receipts.length > 8) throw new Error();
      return { owner: row.owner, session: data.session, receipts: data.receipts,
        lastReply: data.lastReply || null, savedAt: row.saved_at };
    } catch { throw storageError("RECORD_STORAGE_CORRUPT"); }
  }
  load(id, owner) {
    try { return this.decode(this.db.prepare("SELECT * FROM sessions WHERE id=? AND owner=?").get(id, owner)); }
    catch (error) { throw safeStorageError(error); }
  }
  forOwner(owner) {
    try { return this.decode(this.db.prepare("SELECT * FROM sessions WHERE owner=?").get(owner)); }
    catch (error) { throw safeStorageError(error); }
  }
  save(entry, { expectedRevision = null, archive = null } = {}) {
    const savedAt = new Date(this.now()).toISOString();
    const body = JSON.stringify({ session: entry.session, receipts: [...entry.receipts], lastReply: entry.lastReply || null });
    const archiveBody = archive ? JSON.stringify(archive) : null;
    if (Buffer.byteLength(body) > 16 * 1024 * 1024 || (archiveBody && Buffer.byteLength(archiveBody) > 16 * 1024 * 1024)) {
      throw storageError("RECORD_TOO_LARGE");
    }
    let transaction = false;
    try {
      this.db.exec("BEGIN IMMEDIATE"); transaction = true;
      if (expectedRevision === null) {
        const inserted = this.db.prepare("INSERT OR IGNORE INTO sessions (id,owner,revision,body,saved_at) VALUES (?,?,?,?,?)")
          .run(entry.session.session_id, entry.owner, entry.session.revision, body, savedAt);
        if (inserted.changes !== 1) throw storageError("SESSION_REVISION_CONFLICT", 409);
      } else {
        const updated = this.db.prepare("UPDATE sessions SET revision=?,body=?,saved_at=? WHERE id=? AND owner=? AND revision=?")
          .run(entry.session.revision, body, savedAt, entry.session.session_id, entry.owner, expectedRevision);
        if (updated.changes !== 1) throw storageError("SESSION_REVISION_CONFLICT", 409);
      }
      if (archiveBody) this.db.prepare("INSERT INTO archives (id,owner,session_id,revision,body,created_at) VALUES (?,?,?,?,?,?)")
        .run(`${entry.session.session_id}-${entry.session.revision}`, entry.owner, entry.session.session_id, entry.session.revision, archiveBody, savedAt);
      this.db.exec("COMMIT"); transaction = false;
      return savedAt;
    } catch (error) {
      if (transaction) { try { this.db.exec("ROLLBACK"); } catch { /* never overwrite a damaged store */ } }
      throw safeStorageError(error);
    }
  }
  history(owner) {
    try {
      return this.db.prepare("SELECT id,body,created_at FROM archives WHERE owner=? ORDER BY created_at DESC,revision DESC LIMIT 20").all(owner)
        .map(row => {
          const data = JSON.parse(row.body);
          return { id: row.id, created_at: row.created_at, experiment_id: data.session?.experiment_id || null,
            completed_steps: data.session?.completed_steps?.length || 0,
            status: data.session?.status || "IDLE", download_url: `/api/records/${row.id}` };
        });
    } catch (error) { throw safeStorageError(error); }
  }
  archive(id, owner) {
    try {
      const row = this.db.prepare("SELECT body FROM archives WHERE id=? AND owner=?").get(id, owner);
      if (!row) throw storageError("RECORD_NOT_FOUND", 404);
      return JSON.parse(row.body);
    } catch (error) { throw safeStorageError(error); }
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
}

module.exports = { RecordRepository, recordDirectory, storageError };
