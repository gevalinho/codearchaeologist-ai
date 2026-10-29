import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_ARTIFACT_BYTES } from "../architecture/graph";
import { openStateDatabase, privateDirectory } from "./state-db";
import type { GitHubJobStatus } from "./jobs";
import type { GitHubRepository } from "./url";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const FILE = /^[a-f0-9-]{36}\.json$/;
const ACTIVE = new Set(["validating-repository-url", "preparing-isolated-scanner", "fetching-repository", "scanning-supported-source-files", "generating-architecture-graph", "validating-graph"]);
export type JobOwner = { id: string; nonce: string; installationId: number; repositoryId: number };
export type StoredJob = { status: GitHubJobStatus; repo: GitHubRepository; owner?: JobOwner; cancelled: boolean; leaseId: string };
type Row = { id: unknown; repository: unknown; repo_owner: unknown; repo_name: unknown; kind: unknown; owner_id: unknown; owner_nonce: unknown; installation_id: unknown; repository_id: unknown; status_json: unknown; phase: unknown; created_at: unknown; expires_at: unknown; cancelled: unknown; lease_id: unknown };
type ArtifactRow = { file_id: unknown; sha256: unknown; byte_size: unknown; expires_at: unknown };

export class SqliteJobStore {
  private readonly db: DatabaseSync;
  constructor(file: string, private readonly directory: string, private readonly now: () => number = Date.now) {
    privateDirectory(directory);
    this.db = openStateDatabase(file);
    // An active scan lease may belong to another process. Expired leases are safe to reconcile.
    const scanLease = this.db.prepare("SELECT expires_at FROM quota_leases WHERE slot = 'global_scan'").get() as { expires_at: number } | undefined;
    this.reconcile();
    const staging = process.env.CODEARCH_STAGING_DIR;
    if (staging && (!scanLease || scanLease.expires_at <= this.now())) {
      privateDirectory(staging);
      for (const name of readdirSync(staging)) {
        if (!/^codearchaeologist-github-[A-Za-z0-9]{6}$/.test(name)) continue;
        const candidate = path.join(staging, name);
        const entry = lstatSync(candidate);
        if (entry.isDirectory() && entry.mtimeMs <= this.now() - 120_000) rmSync(candidate, { recursive: true, force: true });
      }
    }
    this.sweep();
  }
  close(): void { this.db.close(); }
  private reconcile(): void {
    const lease = this.db.prepare("SELECT expires_at FROM quota_leases WHERE slot = 'global_scan'").get() as { expires_at: number } | undefined;
    if (lease && lease.expires_at > this.now()) return;
    const interrupted = this.db.prepare("SELECT id,status_json FROM github_jobs WHERE phase IN ('validating-repository-url','preparing-isolated-scanner','fetching-repository','scanning-supported-source-files','generating-architecture-graph','validating-graph')").all() as { id: string; status_json: string }[];
    for (const row of interrupted) {
      try {
        const status = JSON.parse(row.status_json) as GitHubJobStatus;
        const failed = { ...status, phase: "failed", error: "GitHub analysis was interrupted or exceeded its lease. Retry the scan." };
        this.db.prepare("UPDATE github_jobs SET status_json = ?, phase = 'failed', cancelled = 1, lease_id = ? WHERE id = ?").run(JSON.stringify(failed), randomUUID(), row.id);
      } catch { this.db.prepare("DELETE FROM github_jobs WHERE id = ?").run(row.id); }
    }
  }
  private file(id: string): string { if (!UUID.test(id)) throw new Error("Invalid artifact identifier."); return path.join(this.directory, `${id}.json`); }
  private remove(id: string): void { if (UUID.test(id)) rmSync(this.file(id), { force: true }); }
  sweep(): void {
    privateDirectory(this.directory);
    this.reconcile();
    const now = this.now();
    const expired = this.db.prepare("SELECT file_id FROM github_artifacts WHERE expires_at <= ? OR job_id IN (SELECT id FROM github_jobs WHERE expires_at <= ?)").all(now, now) as { file_id: string }[];
    this.db.prepare("DELETE FROM github_jobs WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM github_artifacts WHERE expires_at <= ?").run(now);
    for (const row of expired) this.remove(row.file_id);
    const referenced = new Set((this.db.prepare("SELECT file_id FROM github_artifacts").all() as { file_id: string }[]).map(row => `${row.file_id}.json`));
    for (const name of readdirSync(this.directory)) if (FILE.test(name) && !referenced.has(name)) rmSync(path.join(this.directory, name), { force: true });
  }
  count(): number { return (this.db.prepare("SELECT COUNT(*) AS count FROM github_jobs").get() as { count: number }).count; }
  active(): boolean { return (this.db.prepare("SELECT COUNT(*) AS count FROM github_jobs WHERE phase IN ('validating-repository-url','preparing-isolated-scanner','fetching-repository','scanning-supported-source-files','generating-architecture-graph','validating-graph')").get() as { count: number }).count > 0; }
  create(status: GitHubJobStatus, repo: GitHubRepository, leaseId: string, owner?: JobOwner): void {
    this.db.prepare("INSERT INTO github_jobs (id,repository,repo_owner,repo_name,kind,owner_id,owner_nonce,installation_id,repository_id,status_json,phase,created_at,expires_at,cancelled,lease_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)")
      .run(status.id, status.repository, repo.owner, repo.repo, owner ? "private" : "public", owner?.id ?? null, owner?.nonce ?? null, owner?.installationId ?? null, owner?.repositoryId ?? null, JSON.stringify(status), status.phase, Date.parse(status.createdAt), Date.parse(status.expiresAt), leaseId);
  }
  get(id: string): StoredJob | undefined {
    if (!UUID.test(id)) return undefined;
    const row = this.db.prepare("SELECT * FROM github_jobs WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    try {
      if (row.id !== id || typeof row.repo_owner !== "string" || typeof row.repo_name !== "string" || typeof row.status_json !== "string" || typeof row.lease_id !== "string" || !UUID.test(row.lease_id) || !Number.isSafeInteger(row.expires_at) || (row.expires_at as number) <= this.now()) return undefined;
      const status = JSON.parse(row.status_json) as GitHubJobStatus;
      if (status.id !== id || status.phase !== row.phase || status.repository !== row.repository || !["public", "private"].includes(row.kind as string)) return undefined;
      const repo = { owner: row.repo_owner, repo: row.repo_name, canonicalUrl: `https://github.com/${row.repo_owner}/${row.repo_name}` };
      const owner = row.kind === "private" && typeof row.owner_id === "string" && typeof row.owner_nonce === "string" && Number.isSafeInteger(row.installation_id) && Number.isSafeInteger(row.repository_id) ? { id: row.owner_id, nonce: row.owner_nonce, installationId: row.installation_id as number, repositoryId: row.repository_id as number } : undefined;
      if (row.kind === "private" && !owner || row.kind === "public" && (row.owner_id !== null || row.owner_nonce !== null)) return undefined;
      return { status, repo, ...(owner ? { owner } : {}), cancelled: row.cancelled === 1, leaseId: row.lease_id };
    } catch { return undefined; }
  }
  update(id: string, status: GitHubJobStatus, leaseId?: string): void {
    if (!UUID.test(id) || status.id !== id) throw new Error("Invalid job status.");
    if (leaseId) this.db.prepare("UPDATE github_jobs SET status_json = ?, phase = ? WHERE id = ? AND lease_id = ? AND cancelled = 0").run(JSON.stringify(status), status.phase, id, leaseId);
    else this.db.prepare("UPDATE github_jobs SET status_json = ?, phase = ? WHERE id = ?").run(JSON.stringify(status), status.phase, id);
  }
  cancel(id: string, status: GitHubJobStatus): void {
    this.db.prepare("UPDATE github_jobs SET status_json = ?, phase = 'cancelled', cancelled = 1 WHERE id = ?").run(JSON.stringify(status), id);
    this.removeArtifacts(id);
  }
  invalidate(id: string, status: GitHubJobStatus): void { this.cancel(id, { ...status, phase: "cancelled" }); }
  private removeArtifacts(id: string): void {
    const rows = this.db.prepare("SELECT file_id FROM github_artifacts WHERE job_id = ?").all(id) as { file_id: string }[];
    this.db.prepare("DELETE FROM github_artifacts WHERE job_id = ?").run(id);
    for (const row of rows) this.remove(row.file_id);
  }
  publish(id: string, leaseId: string, artifacts: { graphJson: string; manifestJson: string }, ready: GitHubJobStatus): void {
    privateDirectory(this.directory);
    const written: string[] = [];
    try {
      const rows = ([ ["graph.json", artifacts.graphJson], ["manifest.json", artifacts.manifestJson] ] as const).map(([name, content]) => {
        const bytes = Buffer.from(content, "utf8");
        if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the size limit.");
        const fileId = randomUUID(), temporary = path.join(this.directory, `${fileId}.tmp`), target = this.file(fileId);
        const descriptor = openSync(temporary, "wx", 0o600);
        written.push(temporary);
        try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
        renameSync(temporary, target); written.push(target);
        return { name, fileId, sha: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
      });
      const directoryDescriptor = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const job = this.get(id);
        if (!job || job.cancelled || job.leaseId !== leaseId || !ACTIVE.has(job.status.phase)) throw new Error("Job was cancelled or expired.");
        for (const row of rows) this.db.prepare("INSERT INTO github_artifacts (job_id,name,file_id,sha256,byte_size,expires_at) VALUES (?,?,?,?,?,?)").run(id, row.name, row.fileId, row.sha, row.size, Date.parse(ready.expiresAt));
        this.update(id, ready, leaseId);
        this.db.exec("COMMIT;");
      } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
    } catch (error) { for (const file of written) rmSync(file, { force: true }); throw error; }
  }
  artifact(id: string, name: "graph.json" | "manifest.json"): string | undefined {
    privateDirectory(this.directory);
    const job = this.get(id);
    if (!job || job.status.phase !== "ready") return undefined;
    const row = this.db.prepare("SELECT file_id,sha256,byte_size,expires_at FROM github_artifacts WHERE job_id = ? AND name = ?").get(id, name) as ArtifactRow | undefined;
    if (!row || typeof row.file_id !== "string" || !UUID.test(row.file_id) || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.byte_size) || (row.byte_size as number) < 1 || (row.byte_size as number) > MAX_ARTIFACT_BYTES || !Number.isSafeInteger(row.expires_at) || (row.expires_at as number) <= this.now()) return undefined;
    const file = this.file(row.file_id);
    try {
      if (!lstatSync(file).isFile()) return undefined;
      const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || typeof process.getuid === "function" && info.uid !== process.getuid() || info.size !== row.byte_size) return undefined;
        const bytes = readFileSync(descriptor);
        if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) return undefined;
        return bytes.toString("utf8");
      } finally { closeSync(descriptor); }
    } catch { return undefined; }
  }
}
