import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GitHubJobManager, type JobDependencies } from "../src/lib/github-ingestion/jobs";
import { SqliteJobStore } from "../src/lib/github-ingestion/job-store";
import { SqliteQuotaStore } from "../src/lib/github-ingestion/quota-store";
import { SqliteDispatchStore } from "../src/lib/github-ingestion/dispatch-store";
import {
  acknowledgedClaim,
  claimDispatch,
  publishResult,
  readClaimReceipt,
  type SpoolOwners,
  type SpoolRoots,
} from "../src/lib/github-ingestion/spool";
import type { UserSession } from "../src/lib/github-ingestion/session";
import demoGraph from "./fixtures/architecture/demo-graph.json";

vi.mock("server-only", () => ({}));

const FIVE_MINUTES_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const COMMIT = "a".repeat(40);

let root: string, dbPath: string, artifactDir: string, stagingDir: string;
const old = { db: process.env.CODEARCH_DB_PATH, artifacts: process.env.CODEARCH_ARTIFACT_DIR, staging: process.env.CODEARCH_STAGING_DIR };
const repo = "https://github.com/example/repo";
const alice: UserSession = { id: "42", login: "alice", token: "github-user-token", nonce: "a".repeat(43), expiresAt: Date.now() + DAY_MS };
const bob: UserSession = { id: "43", login: "bob", token: "github-user-token", nonce: "b".repeat(43), expiresAt: Date.now() + DAY_MS };
const authorizedPrivate = { id: 11, owner: "example", name: "repo", private: true, installationId: 7 };
const namedUser = (id: string): UserSession => ({ id, login: id, token: "github-user-token", nonce: `${id}-nonce`, expiresAt: Date.now() + DAY_MS });

function deps(overrides: Partial<JobDependencies> = {}): JobDependencies {
  return { available: async () => "sha256:test", acquire: async () => ({ sourceFiles: 2, eligibleFiles: 2, omittedFiles: 0, sourceBytes: 220, skippedFiles: 6, treeEntries: 8, commitSha: COMMIT }), scan: async () => JSON.stringify(demoGraph), temporary: async () => mkdtempSync(path.join(root, "stage-")), cleanup: async value => rmSync(value, { recursive: true, force: true }), now: Date.now, authorize: async () => null, token: async () => "installation-token", ...overrides };
}
const jobRows = () => { const db = new DatabaseSync(dbPath); try { return db.prepare("SELECT id, phase, expires_at FROM github_jobs ORDER BY expires_at").all() as { id: string; phase: string; expires_at: number }[]; } finally { db.close(); } };
const artifactRows = () => { const db = new DatabaseSync(dbPath); try { return db.prepare("SELECT job_id, name, file_id, expires_at FROM github_artifacts").all() as { job_id: string; name: string; file_id: string; expires_at: number }[]; } finally { db.close(); } };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "github-evidence-retention-"));
  dbPath = path.join(root, "state.sqlite"); artifactDir = path.join(root, "artifacts");
  mkdirSync(artifactDir, { mode: 0o700 });
  stagingDir = path.join(root, "staging"); mkdirSync(stagingDir, { mode: 0o700 });
  process.env.CODEARCH_DB_PATH = dbPath; process.env.CODEARCH_ARTIFACT_DIR = artifactDir; process.env.CODEARCH_STAGING_DIR = stagingDir;
});
afterEach(() => {
  if (old.db === undefined) delete process.env.CODEARCH_DB_PATH; else process.env.CODEARCH_DB_PATH = old.db;
  if (old.artifacts === undefined) delete process.env.CODEARCH_ARTIFACT_DIR; else process.env.CODEARCH_ARTIFACT_DIR = old.artifacts;
  if (old.staging === undefined) delete process.env.CODEARCH_STAGING_DIR; else process.env.CODEARCH_STAGING_DIR = old.staging;
  rmSync(root, { recursive: true, force: true });
});

describe("evidence retention", () => {
  it("expires incomplete, failed, and cancelled jobs after five minutes", async () => {
    let now = Date.now();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manager = new GitHubJobManager(deps({ now: () => now, scan: async () => { await gate; return JSON.stringify(demoGraph); } }));
    const active = manager.create(repo);
    await vi.waitFor(() => expect(manager.get(active.id)?.phase).toBe("scanning-supported-source-files"));
    now += FIVE_MINUTES_MS + 1;
    expect(manager.get(active.id)).toBeUndefined();
    release(); await manager.wait(active.id);
    expect(manager.get(active.id)).toBeUndefined();

    const failing = new GitHubJobManager(deps({ now: () => now, scan: async () => { throw new Error("boom"); } }));
    const failed = failing.create(repo); await failing.wait(failed.id);
    expect(failing.get(failed.id)?.phase).toBe("failed");
    now += FIVE_MINUTES_MS + 1;
    expect(failing.get(failed.id)).toBeUndefined();

    let releaseCancelled!: () => void;
    const cancelledGate = new Promise<void>(resolve => { releaseCancelled = resolve; });
    const cancelling = new GitHubJobManager(deps({ now: () => now, scan: async () => { await cancelledGate; return JSON.stringify(demoGraph); } }));
    const cancelled = cancelling.create(repo);
    await vi.waitFor(() => expect(cancelling.get(cancelled.id)?.phase).toBe("scanning-supported-source-files"));
    expect(cancelling.cancel(cancelled.id)?.phase).toBe("cancelled");
    releaseCancelled(); await cancelling.wait(cancelled.id);
    now += FIVE_MINUTES_MS + 1;
    expect(cancelling.get(cancelled.id)).toBeUndefined();
  });

  it("keeps successful jobs available after five minutes", async () => {
    let now = Date.now();
    const manager = new GitHubJobManager(deps({ now: () => now }));
    const job = manager.create(repo); await manager.wait(job.id);
    expect(manager.get(job.id)?.phase).toBe("ready");
    now += FIVE_MINUTES_MS + 1;
    expect(manager.get(job.id)?.phase).toBe("ready");
    expect(await manager.artifact(job.id, "graph.json")).toContain(demoGraph.snapshotId);
    expect(await manager.artifact(job.id, "manifest.json")).toContain("example/repo");
  });

  it("retains successful jobs until 24 hours after completion", async () => {
    let now = Date.now();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manager = new GitHubJobManager(deps({ now: () => now, scan: async () => { await gate; return JSON.stringify(demoGraph); } }));
    const job = manager.create(repo);
    await vi.waitFor(() => expect(manager.get(job.id)?.phase).toBe("scanning-supported-source-files"));
    now += 30_000;
    const completedAt = now;
    release(); await manager.wait(job.id);
    expect(manager.get(job.id)?.expiresAt).toBe(new Date(completedAt + DAY_MS).toISOString());
    now = completedAt + DAY_MS - 1;
    expect(manager.get(job.id)?.phase).toBe("ready");
    expect(await manager.artifact(job.id, "graph.json")).toContain(demoGraph.snapshotId);
  });

  it("expires successful jobs after 24 hours", async () => {
    let now = Date.now();
    const manager = new GitHubJobManager(deps({ now: () => now }));
    const job = manager.create(repo); await manager.wait(job.id);
    now += DAY_MS + 1;
    expect(manager.get(job.id)).toBeUndefined();
    expect(await manager.artifact(job.id, "graph.json")).toBeUndefined();
  });

  it("applies the same 24-hour retention to recovered worker completions", async () => {
    for (const dir of ["inbox", "snapshots", "claims", "outbox"]) mkdirSync(path.join(root, dir), { mode: dir === "claims" ? 0o700 : 0o750 });
    const roots: SpoolRoots = { inbox: path.join(root, "inbox"), snapshots: path.join(root, "snapshots"), claims: path.join(root, "claims"), outbox: path.join(root, "outbox") };
    const uid = process.getuid!(), gid = process.getgid!();
    const owners: SpoolOwners = { webUid: uid, workerUid: uid, workerGid: gid, inboxGid: gid, outboxGid: gid };
    const sources = [
      { path: "application/controllers/Demo.php", bytes: Buffer.alloc(110, 65) },
      { path: "application/controllers/DemoPromotion.php", bytes: Buffer.alloc(110, 66) },
    ];
    const handoffGraph = structuredClone(demoGraph);
    for (const item of [...handoffGraph.nodes, ...handoffGraph.edges]) {
      if (item.source.path === "assets/js/demo.js") item.source.path = "application/controllers/Demo.php";
    }
    let now = Date.now();
    const fileDeps = () => deps({
      now: () => now,
      authorize: async () => authorizedPrivate,
      acquire: async (_repo, destination) => {
        for (const file of sources) {
          mkdirSync(path.dirname(path.join(destination, file.path)), { recursive: true, mode: 0o755 });
          writeFileSync(path.join(destination, file.path), file.bytes, { mode: 0o644 });
        }
        return { sourceFiles: 2, eligibleFiles: 2, omittedFiles: 0, sourceBytes: 220, skippedFiles: 0, treeEntries: 2, commitSha: COMMIT };
      },
    });
    const first = new GitHubJobManager(fileDeps(), undefined, { roots, owners, poll: () => new Promise<void>(() => {}) });
    const job = await first.createPrivate(alice, 7, 11);
    let generation = "";
    await vi.waitFor(() => {
      const store = new SqliteDispatchStore(dbPath);
      try { const state = store.get(job.id); expect(state).toBeDefined(); generation = state!.generation; }
      finally { store.close(); }
    });
    claimDispatch(roots, owners, job.id, generation);
    const recovered = new GitHubJobManager(fileDeps(), undefined, { roots, owners });
    await recovered.authorizedStatus(job.id, alice, async () => alice);
    const receipt = readClaimReceipt(roots, owners, job.id, generation);
    expect(acknowledgedClaim(roots, owners, job.id, generation, receipt)).toBe(true);
    publishResult(roots, owners, job.id, generation, JSON.stringify(handoffGraph));
    expect((await recovered.authorizedStatus(job.id, alice, async () => alice))?.phase).toBe("ready");
    expect(recovered.get(job.id, alice)?.expiresAt).toBe(new Date(now + DAY_MS).toISOString());
    now += 6 * 60_000;
    const third = new GitHubJobManager(fileDeps());
    expect(third.get(job.id, alice)?.phase).toBe("ready");
    expect(await third.artifact(job.id, "graph.json", alice)).toContain(demoGraph.snapshotId);
  });

  it("keeps job and artifact expirations synchronized", async () => {
    const now = Date.now();
    const manager = new GitHubJobManager(deps({ now: () => now }));
    const job = manager.create(repo); await manager.wait(job.id);
    const expected = now + DAY_MS;
    expect(manager.get(job.id)?.expiresAt).toBe(new Date(expected).toISOString());
    expect(jobRows()).toHaveLength(1);
    expect(jobRows()[0].expires_at).toBe(expected);
    const artifacts = artifactRows();
    expect(artifacts).toHaveLength(2);
    for (const row of artifacts) expect(row.expires_at).toBe(expected);
  });

  it("does not count completed jobs against active-scan capacity", async () => {
    const now = Date.now();
    const manager = new GitHubJobManager(deps({ now: () => now }));
    for (let i = 0; i < 3; i++) { const job = manager.create(repo); await manager.wait(job.id); }
    const next = manager.create(repo); await manager.wait(next.id);
    expect(manager.get(next.id)?.phase).toBe("ready");
  });

  it("still enforces active-scan capacity for concurrent investigations", async () => {
    const now = Date.now();
    const quotas = new SqliteQuotaStore(dbPath, () => now);
    const holder = quotas.reserve({ scope: "scan_start", subject: "holder", limit: 5, windowMs: 3_600_000, slot: "global_scan", leaseMs: 95_000 });
    const scratch = new SqliteJobStore(dbPath, artifactDir, () => now);
    for (const phase of ["validating-repository-url", "fetching-repository", "scanning-supported-source-files"] as const) {
      const id = randomUUID();
      scratch.create({ id, phase, repository: "example/repo", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, { owner: "example", repo: "repo", canonicalUrl: "https://github.com/example/repo" }, randomUUID(), undefined, "public");
    }
    scratch.close();
    const manager = new GitHubJobManager(deps({ now: () => now }));
    expect(() => manager.create(repo)).toThrow("Active scan capacity is full. Retry after running scans finish.");
    quotas.release(holder); quotas.close();
  });

  it("does not count failed jobs against active-scan capacity", async () => {
    const now = Date.now();
    const quotas = new SqliteQuotaStore(dbPath, () => now);
    const holder = quotas.reserve({ scope: "scan_start", subject: "holder", limit: 5, windowMs: 3_600_000, slot: "global_scan", leaseMs: 95_000 });
    const scratch = new SqliteJobStore(dbPath, artifactDir, () => now);
    for (const phase of ["fetching-repository", "scanning-supported-source-files", "failed"] as const) {
      const id = randomUUID();
      scratch.create({ id, phase, repository: "example/repo", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, { owner: "example", repo: "repo", canonicalUrl: "https://github.com/example/repo" }, randomUUID(), undefined, "public");
    }
    scratch.close();
    const manager = new GitHubJobManager(deps({ now: () => now }));
    expect(() => manager.create(repo)).toThrow(/quota exceeded/i);
    quotas.release(holder); quotas.close();
  });

  it("deletes expired artifact files and records after 24 hours", async () => {
    let now = Date.now();
    const manager = new GitHubJobManager(deps({ now: () => now }));
    const job = manager.create(repo); await manager.wait(job.id);
    expect(readdirSync(artifactDir)).toHaveLength(2);
    now += DAY_MS + 1;
    const fresh = new GitHubJobManager(deps({ now: () => now }));
    expect(fresh.get(job.id)).toBeUndefined();
    expect(readdirSync(artifactDir)).toHaveLength(0);
    expect(jobRows()).toHaveLength(0);
    expect(artifactRows()).toHaveLength(0);
  });

  it("denies retained evidence to unauthorized users", async () => {
    let now = Date.now();
    const clock = deps({ now: () => now, authorize: async () => authorizedPrivate });
    const manager = new GitHubJobManager(clock);
    const job = await manager.createPrivate(alice, 7, 11); await manager.wait(job.id);
    now += 6 * 60_000;
    const second = new GitHubJobManager(clock);
    expect(second.get(job.id, bob)).toBeUndefined();
    expect(second.cancel(job.id, bob)).toBeUndefined();
    expect(await second.artifact(job.id, "graph.json", bob)).toBeUndefined();
    expect(await second.artifact(job.id, "graph.json", alice)).toContain(demoGraph.snapshotId);
  });

  it("still enforces scan quotas across repeated retained scans", async () => {
    const now = Date.now();
    const manager = new GitHubJobManager(deps({ now: () => now }));
    const subject = namedUser("quota-user");
    for (let i = 0; i < 5; i++) {
      const job = manager.createPublic(repo, subject); await manager.wait(job.id);
      expect(manager.get(job.id, subject)?.phase).toBe("ready");
    }
    expect(() => manager.createPublic(repo, subject)).toThrow(/quota exceeded/i);
  });

  it("bounds completed storage by evicting oldest ready jobs first and never active ones", async () => {
    let now = Date.now();
    const manager = new GitHubJobManager(deps({ now: () => now }));
    const first = manager.create(repo); await manager.wait(first.id);
    let created = 1;
    for (; created < 500; created++) {
      const job = manager.createPublic(repo, namedUser(`evict-${created}`)); await manager.wait(job.id);
      now += 1_000;
      if (!manager.get(first.id)) break;
    }
    expect(created).toBeLessThan(500);
    const retained = jobRows().filter(row => row.phase === "ready").length;
    expect(retained).toBeGreaterThan(0);
    let latest = "", latestUser = namedUser("evict-more-0");
    for (let i = 0; i < 3; i++) {
      latestUser = namedUser(`evict-more-${i}`);
      const job = manager.createPublic(repo, latestUser); await manager.wait(job.id);
      now += 1_000;
      latest = job.id;
    }
    expect(manager.get(latest, latestUser)?.phase).toBe("ready");
    expect(jobRows().filter(row => row.phase === "ready")).toHaveLength(retained);
    const files = new Set(readdirSync(artifactDir));
    expect(files).toEqual(new Set(artifactRows().map(row => `${row.file_id}.json`)));

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const activeManager = new GitHubJobManager(deps({ now: () => now, scan: async () => { await gate; return JSON.stringify(demoGraph); } }));
    const active = activeManager.create(repo);
    await vi.waitFor(() => expect(activeManager.get(active.id)?.phase).toBe("scanning-supported-source-files"));
    const scratch = new SqliteJobStore(dbPath, artifactDir, () => now);
    const staleId = randomUUID(), staleLease = randomUUID();
    scratch.create({ id: staleId, phase: "fetching-repository", repository: "example/old", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, { owner: "example", repo: "old", canonicalUrl: "https://github.com/example/old" }, staleLease, undefined, "public");
    scratch.publish(staleId, staleLease, { graphJson: '{"synthetic":true}', manifestJson: '{"synthetic":true}' }, { id: staleId, phase: "ready", repository: "example/old", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() });
    const staleFiles = artifactRows().filter(row => row.job_id === staleId).map(row => `${row.file_id}.json`);
    expect(staleFiles).toHaveLength(2);
    scratch.close();
    expect(manager.get(active.id)?.phase).toBe("scanning-supported-source-files");
    expect(manager.get(staleId)).toBeUndefined();
    expect(jobRows().filter(row => row.phase === "ready")).toHaveLength(retained);
    for (const file of staleFiles) expect(readdirSync(artifactDir)).not.toContain(file);
    release(); await activeManager.wait(active.id);
    expect(activeManager.get(active.id)?.phase).toBe("ready");
  }, 30_000);

  it("keeps concurrent sweepers from over-evicting ready storage", () => {
    const now = Date.now();
    const quotas = new SqliteQuotaStore(dbPath, () => now);
    const holder = quotas.reserve({ scope: "scan_start", subject: "holder", limit: 5, windowMs: 3_600_000, slot: "global_scan", leaseMs: 95_000 });
    const seed = new SqliteJobStore(dbPath, artifactDir, () => now);
    const repoRef = { owner: "example", repo: "repo", canonicalUrl: "https://github.com/example/repo" };
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) {
      const id = randomUUID(), lease = randomUUID();
      seed.create({ id, phase: "fetching-repository", repository: "example/repo", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, repoRef, lease, undefined, "public");
      seed.publish(id, lease, { graphJson: `{"ready":${i}}`, manifestJson: `{"ready":${i}}` }, { id, phase: "ready", repository: "example/repo", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000 + i * 1_000).toISOString() });
      ids.push(id);
    }
    const activeId = randomUUID();
    seed.create({ id: activeId, phase: "fetching-repository", repository: "example/repo", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, repoRef, randomUUID(), undefined, "public");
    const victimFiles = artifactRows().filter(row => row.job_id === ids[0] || row.job_id === ids[1]).map(row => `${row.file_id}.json`);
    expect(victimFiles).toHaveLength(4);
    seed.close();
    const first = new SqliteJobStore(dbPath, artifactDir, () => now);
    expect(jobRows().filter(row => row.phase === "ready")).toHaveLength(50);
    expect(jobRows().some(row => row.id === ids[0] || row.id === ids[1])).toBe(false);
    const second = new SqliteJobStore(dbPath, artifactDir, () => now);
    first.sweep(); second.sweep();
    expect(jobRows().filter(row => row.phase === "ready")).toHaveLength(50);
    expect(jobRows().find(row => row.id === activeId)?.phase).toBe("fetching-repository");
    expect(artifactRows().some(row => row.job_id === ids[0] || row.job_id === ids[1])).toBe(false);
    const files = new Set(readdirSync(artifactDir));
    expect(files).toEqual(new Set(artifactRows().map(row => `${row.file_id}.json`)));
    for (const file of victimFiles) expect(files.has(file)).toBe(false);
    first.close(); second.close();
    quotas.release(holder); quotas.close();
  });
});
