import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteSessionStore, sessionEncryptionKey, sessionHandleHash, sessionKeyVersion } from "../src/lib/github-ingestion/session-store";

vi.mock("server-only", () => ({}));

const key = randomBytes(32);
let root: string, file: string, store: SqliteSessionStore;
const user = () => ({ id: "42", login: "developer", token: "github-user-token-private", expiresAt: Date.now() + 60_000, nonce: randomBytes(32).toString("base64url") });
const query = (sql: string, ...args: (string | number | Uint8Array)[]) => {
  const db = new DatabaseSync(file);
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-session-store-"));
  file = path.join(root, "sessions.sqlite");
  store = new SqliteSessionStore(file, key, 1);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

describe("durable encrypted GitHub sessions", () => {
  it("creates a hashed-handle, encrypted session and looks it up", () => {
    const identity = user(), handle = store.create(identity);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.lookup(handle)).toEqual(identity);
    expect(query("SELECT handle_hash FROM github_sessions")?.handle_hash).toBe(sessionHandleHash(handle));
    expect(readFileSync(file).includes(Buffer.from(identity.token))).toBe(false);
    expect(store.lookup("invalid")).toBeNull();
  });

  it("caps session lifetime at eight hours and rejects expired records", () => {
    const long = { ...user(), expiresAt: Date.now() + 24 * 60 * 60_000 };
    const handle = store.create(long), row = query("SELECT expires_at FROM github_sessions") as { expires_at: number };
    expect(row.expires_at).toBeLessThanOrEqual(Date.now() + 8 * 60 * 60_000);
    expect(store.lookup(handle)?.expiresAt).toBe(row.expires_at);
    const expired = store.create({ ...user(), expiresAt: Date.now() - 1 });
    expect(store.lookup(expired)).toBeNull();
  });

  it("revokes immediately and persists across a store restart", () => {
    const identity = user(), handle = store.create(identity);
    store.close();
    store = new SqliteSessionStore(file, key, 1);
    expect(store.lookup(handle)).toEqual(identity);
    store.revoke(handle);
    expect(store.lookup(handle)).toBeNull();
    store.close();
    store = new SqliteSessionStore(file, key, 1);
    expect(store.lookup(handle)).toBeNull();
  });

  it("rejects tampered ciphertext and removes the unusable record", () => {
    const handle = store.create(user());
    const db = new DatabaseSync(file);
    try { db.prepare("UPDATE github_sessions SET token_ciphertext = ? WHERE handle_hash = ?").run(Buffer.from("tampered"), sessionHandleHash(handle)); } finally { db.close(); }
    expect(store.lookup(handle)).toBeNull();
    expect(query("SELECT COUNT(*) AS count FROM github_sessions")?.count).toBe(0);
  });

  it("fails closed on malformed records and a changed key version", () => {
    const handle = store.create(user());
    const db = new DatabaseSync(file);
    try { db.prepare("UPDATE github_sessions SET login = ? WHERE handle_hash = ?").run("invalid/login", sessionHandleHash(handle)); } finally { db.close(); }
    expect(store.lookup(handle)).toBeNull();
    const another = store.create(user());
    store.close();
    store = new SqliteSessionStore(file, key, 2);
    expect(store.lookup(another)).toBeNull();
  });

  it("rejects unsafe encryption configuration and future migrations", () => {
    expect(sessionEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(() => sessionEncryptionKey("short")).toThrow();
    expect(sessionKeyVersion("1")).toBe(1);
    expect(() => sessionKeyVersion("0")).toThrow();
    store.close();
    const db = new DatabaseSync(file);
    try { db.exec("PRAGMA user_version=2"); } finally { db.close(); }
    expect(() => new SqliteSessionStore(file, key, 1)).toThrow(/newer/);
    store = new SqliteSessionStore(path.join(root, "fresh.sqlite"), key, 1);
  });
});
