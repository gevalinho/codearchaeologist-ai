import "server-only";
import { closeSync, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function privateDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || directory === "/" || directory.includes("\0")) throw new Error("Private storage directory must be an absolute path.");
  const info = statSync(directory);
  if (!info.isDirectory() || info.mode & 0o077 || typeof process.getuid === "function" && info.uid !== process.getuid() || realpathSync(directory) !== directory) throw new Error("Private storage directory must be owned by the server and mode 0700.");
}

function databasePath(file: string): string {
  if (!path.isAbsolute(file) || file === "/" || file.includes("\0")) throw new Error("GitHub state database path must be absolute.");
  privateDirectory(path.dirname(file));
  try {
    const existing = lstatSync(file);
    if (!existing.isFile() || existing.mode & 0o077 || typeof process.getuid === "function" && existing.uid !== process.getuid()) throw new Error("GitHub state database file must be private and regular.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { closeSync(openSync(file, "wx", 0o600)); }
    catch (created) { if ((created as NodeJS.ErrnoException).code !== "EEXIST") throw created; }
    const created = lstatSync(file);
    if (!created.isFile() || created.mode & 0o077 || typeof process.getuid === "function" && created.uid !== process.getuid()) throw new Error("GitHub state database file must be private and regular.");
  }
  return file;
}

export function openStateDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(databasePath(file), { timeout: 1_000, allowExtension: false });
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version > 4) throw new Error("GitHub state database schema is newer than this application.");
    if (version < 1) {
      db.exec(`CREATE TABLE IF NOT EXISTS github_sessions (
        handle_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, login TEXT NOT NULL,
        token_ciphertext BLOB NOT NULL, token_iv BLOB NOT NULL, token_tag BLOB NOT NULL,
        key_version INTEGER NOT NULL, expires_at INTEGER NOT NULL, nonce TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS github_sessions_expires_at ON github_sessions(expires_at);
      PRAGMA user_version=1;`);
    }
    if (version < 2) {
      db.exec(`CREATE TABLE IF NOT EXISTS github_jobs (
        id TEXT PRIMARY KEY NOT NULL, repository TEXT NOT NULL, repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('public','private')),
        owner_id TEXT, owner_nonce TEXT, installation_id INTEGER, repository_id INTEGER,
        status_json TEXT NOT NULL, phase TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS github_jobs_expires_at ON github_jobs(expires_at);
      CREATE TABLE IF NOT EXISTS github_artifacts (
        job_id TEXT NOT NULL REFERENCES github_jobs(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(name IN ('graph.json','manifest.json')),
        file_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, PRIMARY KEY(job_id,name)
      ) STRICT;
      PRAGMA user_version=2;`);
    }
    if (version < 3) {
      db.exec(`CREATE TABLE IF NOT EXISTS quota_events (scope TEXT NOT NULL, subject TEXT NOT NULL, occurred_at INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS quota_events_lookup ON quota_events(scope,subject,occurred_at);
      CREATE TABLE IF NOT EXISTS quota_leases (slot TEXT PRIMARY KEY NOT NULL, lease_id TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS quota_leases_expiry ON quota_leases(expires_at);
      CREATE TABLE IF NOT EXISTS provider_usage (day INTEGER PRIMARY KEY NOT NULL, attempts INTEGER NOT NULL, reserved_tokens INTEGER NOT NULL, actual_tokens INTEGER NOT NULL) STRICT;
      PRAGMA user_version=3;`);
    }
    if (version < 4) {
      db.exec(`CREATE TABLE IF NOT EXISTS scanner_dispatches (
        job_id TEXT PRIMARY KEY NOT NULL REFERENCES github_jobs(id) ON DELETE CASCADE,
        generation TEXT NOT NULL, job_lease_id TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL, deadline_at INTEGER NOT NULL,
        claim_ack_at INTEGER, heartbeat_at INTEGER, result_sha256 TEXT,
        cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS scanner_dispatches_deadline ON scanner_dispatches(deadline_at);
      PRAGMA user_version=4;`);
    }
    db.exec("COMMIT;");
    return db;
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK;"); db.close(); throw error; }
}
