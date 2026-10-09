const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");
const { recordDirectory, storageError } = require("../server/record-repository");
const { loadEnvFile } = require("../server/env-loader");

async function backupRecords(directory = recordDirectory()) {
  const source = path.join(directory, "records.sqlite");
  if (!fs.existsSync(source)) throw storageError("RECORD_STORAGE_NOT_FOUND");
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw storageError("RECORD_STORAGE_CORRUPT");
    const parent = path.join(directory, "backups");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const targetDirectory = fs.mkdtempSync(path.join(parent, "record-backup-"));
    const destination = path.join(targetDirectory, "records.sqlite");
    await backup(db, destination);
    const check = new DatabaseSync(destination, { readOnly: true });
    try { if (check.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw storageError("RECORD_BACKUP_INVALID"); }
    finally { check.close(); }
    return { backup_file: destination, verified: true, cloud_requests: false };
  } catch (error) { throw error?.status ? error : storageError("RECORD_BACKUP_FAILED"); }
  finally { db?.close(); }
}
if (require.main === module) {
  loadEnvFile(path.join(__dirname, "../.env"));
  backupRecords().then(result => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
    .catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
}
module.exports = { backupRecords };
