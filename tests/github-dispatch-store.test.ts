import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStateDatabase } from "../src/lib/github-ingestion/state-db";
import { SqliteDispatchStore } from "../src/lib/github-ingestion/dispatch-store";

vi.mock("server-only", () => ({}));
let root: string, database: string, job: string, lease: string, generation: string, now: number;
const hash = "a".repeat(64);
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-dispatch-")); mkdirSync(path.join(root, "state"), { mode: 0o700 });
  database = path.join(root, "state", "db.sqlite"); now = Date.now(); job = randomUUID(); lease = randomUUID(); generation = randomUUID();
  const db = openStateDatabase(database);
  db.prepare(`INSERT INTO github_jobs(id,repository,repo_owner,repo_name,kind,owner_id,owner_nonce,status_json,phase,created_at,expires_at,cancelled,lease_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(job, "owner/repo", "owner", "repo", "public", "user", "nonce", "{}", "scanning-supported-source-files", now, now + 300_000, lease);
  db.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("web-owned scanner dispatch state", () => {
  it("atomically accepts one generation and one matching acknowledgement across connections", () => {
    const first = new SqliteDispatchStore(database, () => now), second = new SqliteDispatchStore(database, () => now);
    try {
      expect(first.create(job, lease, generation, hash, now + 60_000)).toBe(true);
      expect(second.create(job, lease, randomUUID(), hash, now + 60_000)).toBe(false);
      expect(second.acknowledge(job, randomUUID(), hash)).toBe(false);
      expect(second.acknowledge(job, generation, "b".repeat(64))).toBe(false);
      expect(first.acknowledge(job, generation, hash)).toBe(true);
      expect(second.acknowledge(job, generation, hash)).toBe(false);
      expect(second.heartbeat(job, generation)).toBe(true);
      expect(first.recordResult(job, generation, "c".repeat(64))).toBe(true);
      expect(second.recordResult(job, generation, "c".repeat(64))).toBe(false);
      expect(first.get(job)).toMatchObject({ generation, manifestSha256: hash, resultSha256: "c".repeat(64), cancelled: false });
    } finally { first.close(); second.close(); }
  });

  it("rejects stale, cancelled, and substituted leases", () => {
    const store = new SqliteDispatchStore(database, () => now);
    try {
      expect(store.create(job, randomUUID(), generation, hash, now + 60_000)).toBe(false);
      expect(store.create(job, lease, generation, hash, now + 60_000)).toBe(true);
      expect(store.cancel(job, generation)).toBe(true);
      expect(store.acknowledge(job, generation, hash)).toBe(false);
      expect(store.recordResult(job, generation, hash)).toBe(false);
      expect(store.heartbeat(job, generation)).toBe(false);
      expect(() => store.get("../escape")).toThrow();
    } finally { store.close(); }
  });

  it("fails closed after a job is cancelled or a dispatch deadline expires", () => {
    const store = new SqliteDispatchStore(database, () => now);
    try {
      expect(store.create(job, lease, generation, hash, now + 1_000)).toBe(true);
      now += 1_001;
      expect(store.acknowledge(job, generation, hash)).toBe(false);
      const db = openStateDatabase(database);
      db.prepare("UPDATE github_jobs SET cancelled=1 WHERE id=?").run(job); db.close();
      expect(store.heartbeat(job, generation)).toBe(false);
    } finally { store.close(); }
  });
});
