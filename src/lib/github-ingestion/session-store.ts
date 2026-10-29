import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UserSession } from "./session";

const MAX_AGE_MS = 8 * 60 * 60_000;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const TOKEN_LIMIT = 4096;

type SessionRow = { handle_hash: unknown; user_id: unknown; login: unknown; token_ciphertext: unknown; token_iv: unknown; token_tag: unknown; key_version: unknown; expires_at: unknown; nonce: unknown };

export function sessionEncryptionKey(encoded: string | undefined): Buffer {
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error("GitHub session encryption key is unavailable.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("GitHub session encryption key is invalid.");
  return key;
}

export function sessionKeyVersion(raw: string | undefined): number {
  if (!raw || !/^[1-9][0-9]{0,8}$/.test(raw)) throw new Error("GitHub session encryption key version is unavailable.");
  return Number(raw);
}

export function sessionHandleHash(handle: string): string {
  return createHash("sha256").update(handle, "utf8").digest("hex");
}

function safeDatabasePath(file: string): string {
  if (!path.isAbsolute(file) || file === "/" || file.includes("\0")) throw new Error("GitHub session database path must be absolute.");
  const parent = path.dirname(file);
  const parentStat = statSync(parent);
  if (!parentStat.isDirectory() || parentStat.mode & 0o077 || typeof process.getuid === "function" && parentStat.uid !== process.getuid() || realpathSync(parent) !== parent) throw new Error("GitHub session database directory must be private and owned by the server.");
  try {
    const existing = lstatSync(file);
    if (!existing.isFile() || existing.mode & 0o077 || typeof process.getuid === "function" && existing.uid !== process.getuid()) throw new Error("GitHub session database file must be private and regular.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { closeSync(openSync(file, "wx", 0o600)); }
    catch (created) { if ((created as NodeJS.ErrnoException).code !== "EEXIST") throw created; }
    const created = lstatSync(file);
    if (!created.isFile() || created.mode & 0o077 || typeof process.getuid === "function" && created.uid !== process.getuid()) throw new Error("GitHub session database file must be private and regular.");
  }
  return file;
}

export class SqliteSessionStore {
  private readonly db: DatabaseSync;
  constructor(file: string, private readonly key: Buffer, private readonly keyVersion: number) {
    if (key.length !== 32 || !Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new Error("Invalid GitHub session encryption configuration.");
    this.db = new DatabaseSync(safeDatabasePath(file), { timeout: 1_000, allowExtension: false });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version > 1) throw new Error("GitHub session database schema is newer than this application.");
      if (version.user_version < 1) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS github_sessions (
          handle_hash TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL,
          login TEXT NOT NULL,
          token_ciphertext BLOB NOT NULL,
          token_iv BLOB NOT NULL,
          token_tag BLOB NOT NULL,
          key_version INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          nonce TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS github_sessions_expires_at ON github_sessions(expires_at);
        PRAGMA user_version=1;`);
      }
      this.db.exec("COMMIT;");
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK;"); this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  create(user: UserSession): string {
    if (!/^[1-9][0-9]{0,19}$/.test(user.id) || !LOGIN.test(user.login) || !HANDLE.test(user.nonce) || typeof user.token !== "string" || user.token.length < 10 || user.token.length > TOKEN_LIMIT || /[\r\n\0]/.test(user.token) || !Number.isSafeInteger(user.expiresAt)) throw new Error("Invalid GitHub session identity.");
    const now = Date.now(), expiresAt = Math.min(user.expiresAt, now + MAX_AGE_MS);
    const handle = randomBytes(32).toString("base64url"), hash = sessionHandleHash(handle);
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${hash}:${user.id}:${this.keyVersion}`));
    const encrypted = Buffer.concat([cipher.update(user.token, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare("DELETE FROM github_sessions WHERE expires_at <= ?").run(now);
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM github_sessions").get() as { count: number };
      if (count.count >= 100) throw new Error("GitHub App session capacity reached.");
      this.db.prepare("INSERT INTO github_sessions (handle_hash,user_id,login,token_ciphertext,token_iv,token_tag,key_version,expires_at,nonce) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(hash, user.id, user.login, encrypted, iv, tag, this.keyVersion, expiresAt, user.nonce);
      this.db.exec("COMMIT;");
      return handle;
    } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
  }

  revoke(handle: string | undefined): void {
    if (handle && HANDLE.test(handle)) this.db.prepare("DELETE FROM github_sessions WHERE handle_hash = ?").run(sessionHandleHash(handle));
  }

  lookup(handle: string | undefined): UserSession | null {
    if (!handle || !HANDLE.test(handle)) return null;
    const hash = sessionHandleHash(handle);
    const row = this.db.prepare("SELECT * FROM github_sessions WHERE handle_hash = ?").get(hash) as SessionRow | undefined;
    if (!row) return null;
    const invalid = () => { this.db.prepare("DELETE FROM github_sessions WHERE handle_hash = ?").run(hash); return null; };
    if (row.handle_hash !== hash || typeof row.user_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(row.user_id) || typeof row.login !== "string" || !LOGIN.test(row.login) || typeof row.nonce !== "string" || !HANDLE.test(row.nonce) || !Number.isSafeInteger(row.expires_at) || (row.expires_at as number) <= Date.now() || (row.expires_at as number) > Date.now() + MAX_AGE_MS || row.key_version !== this.keyVersion || !(row.token_ciphertext instanceof Uint8Array) || !(row.token_iv instanceof Uint8Array) || row.token_iv.length !== 12 || !(row.token_tag instanceof Uint8Array) || row.token_tag.length !== 16) return invalid();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, row.token_iv);
      decipher.setAAD(Buffer.from(`${hash}:${row.user_id}:${this.keyVersion}`));
      decipher.setAuthTag(Buffer.from(row.token_tag));
      const token = Buffer.concat([decipher.update(row.token_ciphertext), decipher.final()]).toString("utf8");
      if (token.length < 10 || token.length > TOKEN_LIMIT || /[\r\n\0]/.test(token)) return invalid();
      return { id: row.user_id, login: row.login, token, expiresAt: row.expires_at as number, nonce: row.nonce };
    } catch { return invalid(); }
  }
}
