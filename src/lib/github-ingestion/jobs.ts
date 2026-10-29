import "server-only";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createManifest, type InvestigationManifest } from "../archaeology/manifest";
import { parseGraph } from "../architecture/graph";
import { acquirePublicRepository, type AcquisitionDiagnostics } from "./acquire";
import { runIsolatedScanner, scannerAvailable } from "./sandbox";
import { parsePublicGitHubUrl, type GitHubRepository } from "./url";
import { authorizeRepository, installationToken, type AuthorizedRepository } from "./app";
import type { UserSession } from "./session";
import { SqliteJobStore, type JobOwner } from "./job-store";
import { privateDirectory } from "./state-db";
import { SqliteQuotaStore, type QuotaLease } from "./quota-store";

export type GitHubJobPhase = "validating-repository-url" | "preparing-isolated-scanner" | "fetching-repository" | "scanning-supported-source-files" | "generating-architecture-graph" | "validating-graph" | "ready" | "failed" | "cancelled";
export type GitHubJobDiagnostics = AcquisitionDiagnostics & { dockerReadinessMs?: number; sandboxScanMs?: number; graphValidationMs?: number };
export type GitHubJobStatus = { id: string; phase: GitHubJobPhase; repository: string; createdAt: string; expiresAt: string; error?: string; diagnostics?: GitHubJobDiagnostics; summary?: { scannedFiles: number; scannedBytes: number; eligibleFiles?: number; selectedFiles?: number; omittedFiles?: number; skippedFiles: number; coverage: "complete-supported-source" | "partial-supported-source"; nodes: number; edges: number; warnings: number } };
type Artifact = { graphJson: string; manifestJson: string };
type Job = { status: GitHubJobStatus; repo: GitHubRepository; controller: AbortController; work?: Promise<void>; owner?: JobOwner; user?: UserSession; authorized?: AuthorizedRepository; leaseId: string; quotaLease?: QuotaLease };
export type JobDependencies = {
  available: () => Promise<string>;
  acquire: typeof acquirePublicRepository;
  scan: typeof runIsolatedScanner;
  temporary: () => Promise<string>;
  cleanup: (root: string) => Promise<void>;
  now: () => number;
  authorize: typeof authorizeRepository;
  token: typeof installationToken;
};
const defaults: JobDependencies = {
  available: scannerAvailable, acquire: acquirePublicRepository, scan: runIsolatedScanner,
  temporary: () => { const root = process.env.CODEARCH_STAGING_DIR; if (!root) throw new Error("GitHub staging directory is unavailable."); privateDirectory(root); return mkdtemp(path.join(root, "codearchaeologist-github-")); },
  cleanup: root => rm(root, { recursive: true, force: true }), now: Date.now, authorize: authorizeRepository, token: installationToken,
};
const EXPIRES_MS = 5 * 60_000;

export class GitHubJobManager {
  private live = new Map<string, Job>();
  private quotas?: SqliteQuotaStore;
  private database?: SqliteJobStore;
  constructor(private readonly deps: JobDependencies = defaults, store?: SqliteJobStore) {
    this.database = store;
  }
  private get store(): SqliteJobStore { return this.database ??= new SqliteJobStore(process.env.CODEARCH_DB_PATH ?? "", process.env.CODEARCH_ARTIFACT_DIR ?? "", this.deps.now); }
  private get quota(): SqliteQuotaStore { return this.quotas ??= new SqliteQuotaStore(process.env.CODEARCH_DB_PATH ?? "", this.deps.now); }

  private sweep() {
    const now = this.deps.now();
    for (const [id, job] of this.live) if (new Date(job.status.expiresAt).getTime() <= now) { job.controller.abort(); this.live.delete(id); }
    this.store.sweep();
  }
  private update(job: Job, phase: GitHubJobPhase, error?: string) {
    if (job.controller.signal.aborted && phase !== "cancelled") return;
    job.status = { ...job.status, phase, error };
    this.store.update(job.status.id, job.status, job.leaseId);
  }
  create(url: string, privateContext?: { user: UserSession; authorized: AuthorizedRepository }): GitHubJobStatus {
    this.sweep();
    const repo = parsePublicGitHubUrl(url);
    if (this.store.count() >= 3) throw new Error("Recent analysis capacity is full. Retry after jobs expire.");
    const quotaLease = this.quota.reserve({ scope: "scan_start", subject: privateContext?.user.id ?? "public-access-key", limit: 2, windowMs: 3_600_000, slot: "global_scan", leaseMs: 95_000 });
    const now = this.deps.now();
    const status: GitHubJobStatus = { id: randomUUID(), phase: "validating-repository-url", repository: `${repo.owner}/${repo.repo}`, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + EXPIRES_MS).toISOString() };
    const job: Job = { status, repo, controller: new AbortController(), leaseId: randomUUID(), quotaLease };
    if (privateContext) { const { user, authorized } = privateContext; job.owner = { id: user.id, nonce: user.nonce, installationId: authorized.installationId, repositoryId: authorized.id }; job.user = user; job.authorized = authorized; }
    try { this.store.create(status, repo, job.leaseId, job.owner); }
    catch (error) { this.quota.release(quotaLease); throw error; }
    this.live.set(status.id, job);
    job.work = this.run(job).catch(() => { if (!job.controller.signal.aborted) this.update(job, "failed", "GitHub analysis failed."); });
    return { ...status };
  }
  async createPrivate(user: UserSession, installationId: number, repositoryId: number): Promise<GitHubJobStatus> {
    const authorized = await this.deps.authorize(user, installationId, repositoryId);
    if (!authorized) throw new Error("Repository is unavailable or you are not authorized.");
    return this.create(`https://github.com/${authorized.owner}/${authorized.name}`, { user, authorized });
  }
  private owned(job: { owner?: JobOwner } | undefined, user?: UserSession): boolean {
    return !!job && (!job.owner || !!user && job.owner.id === user.id && job.owner.nonce === user.nonce);
  }
  privateJob(id: string): boolean | undefined { this.sweep(); const job = this.store.get(id); return job ? !!job.owner : undefined; }
  private async run(job: Job) {
    let root: string | undefined;
    let completed: { artifact: Artifact; summary: NonNullable<GitHubJobStatus["summary"]> } | undefined;
    const deadline = setTimeout(() => { this.update(job, "failed", "GitHub analysis exceeded its 90-second deadline."); job.controller.abort(); }, 90_000);
    deadline.unref();
    const heartbeat = setInterval(() => {
      try { if (job.quotaLease && !this.quota.renew(job.quotaLease, 95_000)) { this.update(job, "failed", "Scan lease expired. Retry the analysis."); job.controller.abort(); } }
      catch { try { this.update(job, "failed", "Scan lease could not be renewed."); } catch { /* The scan is aborted if quota storage is unavailable. */ } job.controller.abort(); }
    }, 10_000);
    heartbeat.unref();
    const recordTiming = (values: Partial<GitHubJobDiagnostics>) => { job.status = { ...job.status, diagnostics: { selectedBlobs: 0, completedBlobs: 0, failedBlobs: 0, ...job.status.diagnostics, ...values } }; this.store.update(job.status.id, job.status, job.leaseId); };
    try {
      this.update(job, "preparing-isolated-scanner");
      const readinessStarted = performance.now();
      const image = await this.deps.available();
      recordTiming({ dockerReadinessMs: Math.round(performance.now() - readinessStarted) });
      if (job.controller.signal.aborted) return;
      root = await this.deps.temporary();
      this.update(job, "fetching-repository");
      let token: string | undefined;
      if (job.owner && job.user && job.authorized) {
        const fresh = await this.deps.authorize(job.user, job.owner.installationId, job.owner.repositoryId);
        if (!fresh || fresh.owner !== job.authorized.owner || fresh.name !== job.authorized.name) throw new Error("Repository authorization expired or was revoked.");
        token = await this.deps.token(fresh);
      }
      const acquired = await this.deps.acquire(job.repo, path.join(root, "repo"), job.controller.signal, undefined, token, diagnostics => recordTiming(diagnostics));
      if (job.controller.signal.aborted) return;
      this.update(job, "scanning-supported-source-files");
      const scanStarted = performance.now();
      const scannerOutput = await this.deps.scan(root, image, job.controller.signal);
      recordTiming({ sandboxScanMs: Math.round(performance.now() - scanStarted) });
      if (job.controller.signal.aborted) return;
      this.update(job, "generating-architecture-graph");
      const graphStarted = performance.now();
      const graph = parseGraph(scannerOutput);
      const eligibleFiles = acquired.eligibleFiles ?? acquired.sourceFiles, omittedFiles = acquired.omittedFiles ?? 0;
      const partial = omittedFiles > 0 || acquired.skippedFiles > 0 || graph.scan.fileCount < acquired.sourceFiles;
      graph.sourceCoverage = { eligibleFiles, selectedFiles: acquired.sourceFiles, omittedFiles, analyzedFiles: graph.scan.fileCount, skippedFiles: acquired.skippedFiles, partial };
      graph.githubSource = { owner: acquired.canonicalOwner ?? job.repo.owner, name: acquired.canonicalName ?? job.repo.repo, commitSha: acquired.commitSha, visibility: job.owner ? "private" : "public" };
      graph.limitations.push(`Complete GitHub commit tree inspected (${acquired.treeEntries} entries). Eligible: ${eligibleFiles}; selected: ${acquired.sourceFiles}; omitted eligible files: ${omittedFiles}; analyzed: ${graph.scan.fileCount}; excluded or unsupported: ${acquired.skippedFiles}. ${partial ? "This is a partial assessment. Missing components and relationships cannot establish that a feature is absent." : "All eligible files were analyzed."}`);
      const manifest: InvestigationManifest = createManifest(graph, `${job.repo.owner}/${job.repo.repo}`);
      const graphJson = `${JSON.stringify(graph, null, 2)}\n`, manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
      this.update(job, "validating-graph");
      parseGraph(graphJson);
      recordTiming({ graphValidationMs: Math.round(performance.now() - graphStarted) });
      if (job.controller.signal.aborted) return;
      completed = { artifact: { graphJson, manifestJson }, summary: { scannedFiles: graph.scan.fileCount, scannedBytes: graph.scan.totalBytes, eligibleFiles, selectedFiles: acquired.sourceFiles, omittedFiles, skippedFiles: acquired.skippedFiles, coverage: partial ? "partial-supported-source" : "complete-supported-source", nodes: graph.nodes.length, edges: graph.edges.length, warnings: graph.warnings.length } };
    } catch (error) {
      if (!job.controller.signal.aborted) this.update(job, "failed", error instanceof Error ? error.message : "GitHub analysis failed.");
    } finally {
      clearTimeout(deadline);
      try {
        let cleaned = true;
        if (root) await this.deps.cleanup(root).catch(() => { cleaned = false; if (!job.controller.signal.aborted) this.update(job, "failed", "Temporary scanner cleanup failed."); });
        if (cleaned && completed && !job.controller.signal.aborted) {
          let authorized = true;
          if (job.owner && job.user) {
            const fresh = await this.deps.authorize(job.user, job.owner.installationId, job.owner.repositoryId).catch(() => null);
            if (!fresh || fresh.owner !== job.authorized?.owner || fresh.name !== job.authorized.name) { this.update(job, "failed", "Repository authorization expired or was revoked."); authorized = false; }
          }
          if (authorized) {
            const ready = { ...job.status, phase: "ready" as const, summary: completed.summary };
            try { this.store.publish(job.status.id, job.leaseId, completed.artifact, ready); job.status = ready; }
            catch { this.update(job, "failed", "Could not publish validated scan artifacts."); }
          }
        }
      } finally {
        clearInterval(heartbeat);
        this.live.delete(job.status.id);
        this.quota.release(job.quotaLease);
      }
    }
  }
  get(id: string, user?: UserSession): GitHubJobStatus | undefined { this.sweep(); const job = this.store.get(id); return this.owned(job, user) ? job?.status : undefined; }
  async authorizedStatus(id: string, user?: UserSession): Promise<GitHubJobStatus | undefined> {
    this.sweep(); const job = this.store.get(id);
    if (!job || !this.owned(job, user)) return undefined;
    if (job?.owner && user && !await this.deps.authorize(user, job.owner.installationId, job.owner.repositoryId).catch(() => null)) { this.live.get(id)?.controller.abort(); this.store.invalidate(id, job.status); return undefined; }
    return job ? { ...job.status } : undefined;
  }
  async artifact(id: string, name: "graph.json" | "manifest.json", user?: UserSession): Promise<string | undefined> {
    this.sweep(); const job = this.store.get(id);
    if (!job || !this.owned(job, user) || job.status.phase !== "ready") return undefined;
    if (job.owner && user && !await this.deps.authorize(user, job.owner.installationId, job.owner.repositoryId).catch(() => null)) { this.store.invalidate(id, job.status); return undefined; }
    return this.store.artifact(id, name);
  }
  cancel(id: string, user?: UserSession): GitHubJobStatus | undefined {
    this.sweep(); const job = this.store.get(id); if (!job || !this.owned(job, user)) return undefined;
    if (job.status.phase !== "ready" && job.status.phase !== "failed") { this.live.get(id)?.controller.abort(); const status = { ...job.status, phase: "cancelled" as const }; this.store.cancel(id, status); return status; }
    return job.status;
  }
  async wait(id: string): Promise<void> { await this.live.get(id)?.work; }
}

const singletonKey = Symbol.for("codearchaeologist.github-ingestion.jobs");
const shared = globalThis as typeof globalThis & { [singletonKey]?: GitHubJobManager };
export const githubJobs = shared[singletonKey] ??= new GitHubJobManager();
