import "server-only";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createManifest, type InvestigationManifest } from "../archaeology/manifest";
import { parseGraph } from "../architecture/graph";
import { acquirePublicRepository, type AcquisitionDiagnostics } from "./acquire";
import { runIsolatedScanner, scannerAvailable } from "./sandbox";
import { parsePublicGitHubUrl, type GitHubRepository } from "./url";
import { authorizeRepository, installationToken, type AuthorizedRepository } from "./app";
import type { UserSession } from "./session";

export type GitHubJobPhase = "validating-repository-url" | "preparing-isolated-scanner" | "fetching-repository" | "scanning-supported-source-files" | "generating-architecture-graph" | "validating-graph" | "ready" | "failed" | "cancelled";
export type GitHubJobDiagnostics = AcquisitionDiagnostics & { dockerReadinessMs?: number; sandboxScanMs?: number; graphValidationMs?: number };
export type GitHubJobStatus = { id: string; phase: GitHubJobPhase; repository: string; createdAt: string; expiresAt: string; error?: string; diagnostics?: GitHubJobDiagnostics; summary?: { scannedFiles: number; scannedBytes: number; eligibleFiles?: number; selectedFiles?: number; omittedFiles?: number; skippedFiles: number; coverage: "complete-supported-source" | "partial-supported-source"; nodes: number; edges: number; warnings: number } };
type Artifact = { graphJson: string; manifestJson: string };
type Job = { status: GitHubJobStatus; repo: GitHubRepository; controller: AbortController; artifact?: Artifact; work?: Promise<void>; owner?: { id: string; nonce: string; installationId: number; repositoryId: number }; user?: UserSession; authorized?: AuthorizedRepository };
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
  temporary: () => mkdtemp(path.join(tmpdir(), "codearchaeologist-github-")),
  cleanup: root => rm(root, { recursive: true, force: true }), now: Date.now, authorize: authorizeRepository, token: installationToken,
};
const EXPIRES_MS = 5 * 60_000;

export class GitHubJobManager {
  private jobs = new Map<string, Job>();
  private created: number[] = [];
  constructor(private readonly deps: JobDependencies = defaults) {}

  private sweep() {
    const now = this.deps.now();
    this.created = this.created.filter(time => now - time < 60_000);
    for (const [id, job] of this.jobs) if (new Date(job.status.expiresAt).getTime() <= now) { job.controller.abort(); this.jobs.delete(id); }
  }
  private update(job: Job, phase: GitHubJobPhase, error?: string) {
    if (job.controller.signal.aborted && phase !== "cancelled") return;
    job.status = { ...job.status, phase, error };
  }
  create(url: string, privateContext?: { user: UserSession; authorized: AuthorizedRepository }): GitHubJobStatus {
    this.sweep();
    if (this.created.length >= 3) throw new Error("GitHub analysis rate limit reached. Retry in a minute.");
    if ([...this.jobs.values()].some(job => !["ready", "failed", "cancelled"].includes(job.status.phase))) throw new Error("An analysis is already running. Wait or cancel it first.");
    if (this.jobs.size >= 3) throw new Error("Recent analysis capacity is full. Retry after jobs expire.");
    const repo = parsePublicGitHubUrl(url);
    const now = this.deps.now();
    const status: GitHubJobStatus = { id: randomUUID(), phase: "validating-repository-url", repository: `${repo.owner}/${repo.repo}`, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + EXPIRES_MS).toISOString() };
    const job: Job = { status, repo, controller: new AbortController() };
    if (privateContext) { const { user, authorized } = privateContext; job.owner = { id: user.id, nonce: user.nonce, installationId: authorized.installationId, repositoryId: authorized.id }; job.user = user; job.authorized = authorized; }
    this.jobs.set(status.id, job); this.created.push(now);
    job.work = this.run(job).catch(() => { if (!job.controller.signal.aborted) this.update(job, "failed", "GitHub analysis failed."); });
    return { ...status };
  }
  async createPrivate(user: UserSession, installationId: number, repositoryId: number): Promise<GitHubJobStatus> {
    const authorized = await this.deps.authorize(user, installationId, repositoryId);
    if (!authorized) throw new Error("Repository is unavailable or you are not authorized.");
    return this.create(`https://github.com/${authorized.owner}/${authorized.name}`, { user, authorized });
  }
  private owned(job: Job | undefined, user?: UserSession): boolean {
    return !!job && (!job.owner || !!user && job.owner.id === user.id && job.owner.nonce === user.nonce);
  }
  privateJob(id: string): boolean | undefined { this.sweep(); const job = this.jobs.get(id); return job ? !!job.owner : undefined; }
  private async run(job: Job) {
    let root: string | undefined;
    let completed: { artifact: Artifact; summary: NonNullable<GitHubJobStatus["summary"]> } | undefined;
    const deadline = setTimeout(() => { this.update(job, "failed", "GitHub analysis exceeded its 90-second deadline."); job.controller.abort(); }, 90_000);
    deadline.unref();
    const recordTiming = (values: Partial<GitHubJobDiagnostics>) => { job.status = { ...job.status, diagnostics: { selectedBlobs: 0, completedBlobs: 0, failedBlobs: 0, ...job.status.diagnostics, ...values } }; };
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
      let cleaned = true;
      if (root) await this.deps.cleanup(root).catch(() => { cleaned = false; if (!job.controller.signal.aborted) this.update(job, "failed", "Temporary scanner cleanup failed."); });
      if (cleaned && completed && !job.controller.signal.aborted) {
        if (job.owner && job.user) {
          const fresh = await this.deps.authorize(job.user, job.owner.installationId, job.owner.repositoryId).catch(() => null);
          if (!fresh || fresh.owner !== job.authorized?.owner || fresh.name !== job.authorized.name) { this.update(job, "failed", "Repository authorization expired or was revoked."); return; }
        }
        job.artifact = completed.artifact;
        job.status = { ...job.status, phase: "ready", summary: completed.summary };
      }
    }
  }
  get(id: string, user?: UserSession): GitHubJobStatus | undefined { this.sweep(); const job = this.jobs.get(id); return this.owned(job, user) ? { ...job!.status } : undefined; }
  async authorizedStatus(id: string, user?: UserSession): Promise<GitHubJobStatus | undefined> {
    this.sweep(); const job = this.jobs.get(id);
    if (!job || !this.owned(job, user)) return undefined;
    if (job?.owner && user && !await this.deps.authorize(user, job.owner.installationId, job.owner.repositoryId).catch(() => null)) { job.controller.abort(); job.artifact = undefined; this.update(job, "cancelled"); return undefined; }
    return job ? { ...job.status } : undefined;
  }
  async artifact(id: string, name: "graph.json" | "manifest.json", user?: UserSession): Promise<string | undefined> {
    this.sweep(); const job = this.jobs.get(id);
    if (!job || !this.owned(job, user) || job.status.phase !== "ready") return undefined;
    if (job.owner && user && !await this.deps.authorize(user, job.owner.installationId, job.owner.repositoryId).catch(() => null)) { job.artifact = undefined; return undefined; }
    return job.artifact?.[name === "graph.json" ? "graphJson" : "manifestJson"];
  }
  cancel(id: string, user?: UserSession): GitHubJobStatus | undefined {
    this.sweep(); const job = this.jobs.get(id); if (!job || !this.owned(job, user)) return undefined;
    if (job.status.phase !== "ready" && job.status.phase !== "failed") { job.controller.abort(); this.update(job, "cancelled"); job.artifact = undefined; }
    return { ...job.status };
  }
  async wait(id: string): Promise<void> { await this.jobs.get(id)?.work; }
}

const singletonKey = Symbol.for("codearchaeologist.github-ingestion.jobs");
const shared = globalThis as typeof globalThis & { [singletonKey]?: GitHubJobManager };
export const githubJobs = shared[singletonKey] ??= new GitHubJobManager();
