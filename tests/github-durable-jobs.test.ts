import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GitHubJobManager, type JobDependencies } from "../src/lib/github-ingestion/jobs";
import { SqliteJobStore } from "../src/lib/github-ingestion/job-store";
import type { UserSession } from "../src/lib/github-ingestion/session";
import demoGraph from "./fixtures/architecture/demo-graph.json";

vi.mock("server-only", () => ({}));

let root: string, dbPath: string, artifactDir: string, stagingDir: string;
const old = { db: process.env.CODEARCH_DB_PATH, artifacts: process.env.CODEARCH_ARTIFACT_DIR, staging: process.env.CODEARCH_STAGING_DIR };
const repo = "https://github.com/example/repo";
const alice: UserSession = { id: "42", login: "alice", token: "github-user-token", nonce: "a".repeat(43), expiresAt: Date.now() + 60_000 };
const bob: UserSession = { ...alice, id: "43", login: "bob", nonce: "b".repeat(43) };
const authorized = { id: 11, owner: "example", name: "repo", private: true, installationId: 7 };
function deps(overrides: Partial<JobDependencies> = {}): JobDependencies {
  return { available: async () => "sha256:test", acquire: async () => ({ sourceFiles: 2, eligibleFiles: 2, omittedFiles: 0, sourceBytes: 100, skippedFiles: 0, treeEntries: 2, commitSha: "a".repeat(40) }), scan: async () => JSON.stringify(demoGraph), temporary: async () => mkdtempSync(path.join(root, "stage-")), cleanup: async value => rmSync(value, { recursive: true, force: true }), now: Date.now, authorize: async () => authorized, token: async () => "installation-token-private", ...overrides };
}
const records = () => { const db = new DatabaseSync(dbPath); try { return db.prepare("SELECT file_id FROM github_artifacts ORDER BY name").all() as { file_id: string }[]; } finally { db.close(); } };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "github-durable-job-"));
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

describe("durable GitHub jobs and private artifacts", () => {
  it("persists a ready job and artifacts across a new manager", async () => {
    const first = new GitHubJobManager(deps()), job = first.create(repo); await first.wait(job.id);
    const second = new GitHubJobManager(deps());
    expect(second.get(job.id)?.phase).toBe("ready");
    expect(await second.artifact(job.id, "graph.json")).toContain(demoGraph.snapshotId);
    expect(await second.artifact(job.id, "manifest.json")).toContain("example/repo");
    expect(records()).toHaveLength(2);
  });

  it("does not republish interrupted work after restart", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = new GitHubJobManager(deps({ scan: async () => { await gate; return JSON.stringify(demoGraph); } }));
    const job = first.create(repo);
    await vi.waitFor(() => expect(first.get(job.id)?.phase).toBe("scanning-supported-source-files"));
    const second = new GitHubJobManager(deps());
    expect(second.get(job.id)).toMatchObject({ phase: "failed", error: expect.stringContaining("interrupted") });
    release(); await first.wait(job.id);
    expect(second.get(job.id)?.phase).toBe("failed");
    expect(await second.artifact(job.id, "graph.json")).toBeUndefined();
  });

  it("keeps private ownership and GitHub reauthorization after restart", async () => {
    const first = new GitHubJobManager(deps()), job = await first.createPrivate(alice, 7, 11); await first.wait(job.id);
    const second = new GitHubJobManager(deps());
    expect(second.get(job.id, bob)).toBeUndefined();
    expect(second.cancel(job.id, bob)).toBeUndefined();
    expect(await second.artifact(job.id, "graph.json", bob)).toBeUndefined();
    expect(await second.artifact(job.id, "graph.json", alice)).toContain(demoGraph.snapshotId);
    const denied = new GitHubJobManager(deps({ authorize: async () => null }));
    expect(await denied.artifact(job.id, "graph.json", alice)).toBeUndefined();
    expect(records()).toHaveLength(0);
  });

  it("persists cancellation and prevents artifact publication", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manager = new GitHubJobManager(deps({ scan: async () => { await gate; return JSON.stringify(demoGraph); } }));
    const job = manager.create(repo);
    await vi.waitFor(() => expect(manager.get(job.id)?.phase).toBe("scanning-supported-source-files"));
    expect(manager.cancel(job.id)?.phase).toBe("cancelled");
    release(); await manager.wait(job.id);
    expect(new GitHubJobManager(deps()).get(job.id)?.phase).toBe("cancelled");
    expect(records()).toHaveLength(0);
  });

  it("rejects changed bytes and symlinked artifacts", async () => {
    const manager = new GitHubJobManager(deps()), job = manager.create(repo); await manager.wait(job.id);
    const id = records()[0].file_id, file = path.join(artifactDir, `${id}.json`);
    writeFileSync(file, "tampered");
    expect(await manager.artifact(job.id, "graph.json")).toBeUndefined();
    expect(await manager.artifact(job.id, "manifest.json")).toContain("example/repo");
    const rows = records();
    for (const row of rows) {
      const candidate = path.join(artifactDir, `${row.file_id}.json`);
      rmSync(candidate, { force: true }); symlinkSync(path.join(root, "state.sqlite"), candidate);
    }
    expect(await manager.artifact(job.id, "graph.json")).toBeUndefined();
    expect(await manager.artifact(job.id, "manifest.json")).toBeUndefined();
  });

  it("expires jobs and removes orphan files without accepting traversals", async () => {
    let now = Date.now();
    const clock = deps({ now: () => now });
    const manager = new GitHubJobManager(clock), job = manager.create(repo); await manager.wait(job.id);
    const orphan = path.join(artifactDir, `${randomUUID()}.json`); writeFileSync(orphan, "orphan", { mode: 0o600 });
    expect(manager.get("../../secret")).toBeUndefined();
    expect(await manager.artifact("../../secret", "graph.json")).toBeUndefined();
    now += 5 * 60_000 + 1;
    expect(new GitHubJobManager(clock).get(job.id)).toBeUndefined();
    expect(readdirSync(artifactDir)).toHaveLength(0);
  });

  it("cleans only generated staging directories after restart", () => {
    const abandoned = path.join(stagingDir, "codearchaeologist-github-AbC123");
    const unrelated = path.join(stagingDir, "keep-me");
    mkdirSync(abandoned); mkdirSync(unrelated);
    symlinkSync(unrelated, path.join(stagingDir, "codearchaeologist-github-XyZ789"));
    const store = new SqliteJobStore(dbPath, artifactDir);
    expect(readdirSync(stagingDir).sort()).toEqual(["codearchaeologist-github-XyZ789", "keep-me"]);
    store.close();
  });

  it("rejects a public artifact directory and malformed stored job", () => {
    chmodSync(artifactDir, 0o755);
    expect(() => new SqliteJobStore(dbPath, artifactDir)).toThrow(/Private/);
    chmodSync(artifactDir, 0o700);
    const manager = new GitHubJobManager(deps()), job = manager.create(repo);
    const db = new DatabaseSync(dbPath);
    try { db.prepare("UPDATE github_jobs SET status_json = ? WHERE id = ?").run("invalid", job.id); } finally { db.close(); }
    expect(manager.get(job.id)).toBeUndefined();
    expect(readFileSync(dbPath).includes(Buffer.from("installation-token-private"))).toBe(false);
  });
});
