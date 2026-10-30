import "server-only";
import { createHash, randomUUID } from "node:crypto";
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
import { SqliteDispatchStore, type AcquiredSource } from "./dispatch-store";
import { readAcquiredSnapshot } from "./acquired-snapshot";
import { cleanupWebSpool, markCancelled, publishClaimAcknowledgement, publishSnapshot, readClaimReceipt, readResult, readSnapshotManifest, readWorkerHeartbeat, type SpoolOwners, type SpoolRoots } from "./spool";

export type GitHubJobPhase = "validating-repository-url" | "preparing-isolated-scanner" | "fetching-repository" | "scanning-supported-source-files" | "generating-architecture-graph" | "validating-graph" | "ready" | "failed" | "cancelled";
export type GitHubJobDiagnostics = AcquisitionDiagnostics & { dockerReadinessMs?: number; sandboxScanMs?: number; graphValidationMs?: number };
export type GitHubJobStatus = { id: string; phase: GitHubJobPhase; repository: string; createdAt: string; expiresAt: string; error?: string; diagnostics?: GitHubJobDiagnostics; summary?: { scannedFiles: number; scannedBytes: number; eligibleFiles?: number; selectedFiles?: number; omittedFiles?: number; skippedFiles: number; coverage: "complete-supported-source" | "partial-supported-source"; nodes: number; edges: number; warnings: number } };
type Artifact = { graphJson: string; manifestJson: string };
export type WorkerHandoff = { roots: SpoolRoots; owners: SpoolOwners; poll?: (ms: number) => Promise<void> };
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
  private dispatches?: SqliteDispatchStore;
  constructor(private readonly deps: JobDependencies = defaults, store?: SqliteJobStore, private readonly handoff?: WorkerHandoff) {
    this.database = store;
  }
  private get store(): SqliteJobStore { return this.database ??= new SqliteJobStore(process.env.CODEARCH_DB_PATH ?? "", process.env.CODEARCH_ARTIFACT_DIR ?? "", this.deps.now); }
  private get quota(): SqliteQuotaStore { return this.quotas ??= new SqliteQuotaStore(process.env.CODEARCH_DB_PATH ?? "", this.deps.now); }
  private get dispatch(): SqliteDispatchStore { return this.dispatches ??= new SqliteDispatchStore(process.env.CODEARCH_DB_PATH ?? "", this.deps.now); }
  private cancelHandoff(id: string): void {
    if (!this.handoff) return;
    const state = this.dispatch.get(id);
    if (!state) return;
    this.dispatch.cancel(id, state.generation);
    try { markCancelled(this.handoff.roots, this.handoff.owners, id, state.generation); } catch { /* SQLite denial and deadline remain authoritative. */ }
  }
  private async workerOutput(job: Job, root: string, acquired: AcquiredSource): Promise<{ output: string; generation: string; resultSha256: string }> {
    if (!this.handoff || !job.quotaLease) throw new Error("Worker handoff is unavailable.");
    const generation = randomUUID(), deadline = Date.parse(job.status.createdAt) + 90_000;
    const files = readAcquiredSnapshot(path.join(root, "repo"), acquired.sourceFiles, acquired.sourceBytes);
    const dispatch = publishSnapshot(this.handoff.roots, this.handoff.owners, job.status.id, generation, files, deadline);
    if (!this.dispatch.create(job.status.id, job.leaseId, generation, dispatch.manifestSha256, deadline, acquired, job.quotaLease.id)) {
      markCancelled(this.handoff.roots, this.handoff.owners, job.status.id, generation);
      throw new Error("Worker dispatch could not be recorded.");
    }
    const sleep = this.handoff.poll ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let acknowledgedAt: number | undefined;
    while (!job.controller.signal.aborted && this.deps.now() < deadline) {
      const current = this.dispatch.get(job.status.id);
      if (!current || current.cancelled || current.generation !== generation || current.manifestSha256 !== dispatch.manifestSha256 || this.store.get(job.status.id)?.leaseId !== job.leaseId) break;
      if (!acknowledgedAt) {
        try {
          const receiptHash = readClaimReceipt(this.handoff.roots, this.handoff.owners, job.status.id, generation);
          if (receiptHash !== dispatch.manifestSha256 || !this.dispatch.acknowledge(job.status.id, generation, receiptHash)) throw new Error("Worker claim could not be acknowledged.");
          publishClaimAcknowledgement(this.handoff.roots, this.handoff.owners, job.status.id, generation, receiptHash);
          acknowledgedAt = this.deps.now();
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } else {
        try {
          const output = readResult(this.handoff.roots, this.handoff.owners, job.status.id, generation);
          const graph = parseGraph(output);
          if (graph.scan.fileCount > acquired.sourceFiles || graph.scan.totalBytes > acquired.sourceBytes) throw new Error("Worker graph exceeds acquired source coverage.");
          this.validateWorkerSources(job.status.id, generation, output);
          const resultSha256 = createHash("sha256").update(output).digest("hex");
          if (!this.dispatch.recordResult(job.status.id, generation, resultSha256)) throw new Error("Worker result is stale or duplicated.");
          return { output, generation, resultSha256 };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try {
          const heartbeatAt = readWorkerHeartbeat(this.handoff.roots, this.handoff.owners, job.status.id, generation);
          if (this.deps.now() - heartbeatAt > 5_000 || !this.dispatch.heartbeat(job.status.id, generation)) throw new Error("Worker heartbeat expired.");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || this.deps.now() - acknowledgedAt > 5_000) throw error; }
      }
      await sleep(100);
    }
    this.cancelHandoff(job.status.id);
    throw new Error("Worker dispatch expired, was cancelled, or lost its lease.");
  }
  private buildArtifacts(repo: GitHubRepository, visibility: "private" | "public", acquired: AcquiredSource, scannerOutput: string, strict: boolean): { artifact: Artifact; summary: NonNullable<GitHubJobStatus["summary"]> } {
    const graph = parseGraph(scannerOutput);
    if (strict && (graph.scan.fileCount > acquired.sourceFiles || graph.scan.totalBytes > acquired.sourceBytes)) throw new Error("Worker graph exceeds acquired source coverage.");
    const eligibleFiles = acquired.eligibleFiles ?? acquired.sourceFiles, omittedFiles = acquired.omittedFiles ?? 0;
    const partial = omittedFiles > 0 || acquired.skippedFiles > 0 || graph.scan.fileCount < acquired.sourceFiles;
    graph.sourceCoverage = { eligibleFiles, selectedFiles: acquired.sourceFiles, omittedFiles, analyzedFiles: graph.scan.fileCount, skippedFiles: acquired.skippedFiles, partial };
    graph.githubSource = { owner: acquired.canonicalOwner ?? repo.owner, name: acquired.canonicalName ?? repo.repo, commitSha: acquired.commitSha, visibility };
    graph.limitations.push(`Complete GitHub commit tree inspected (${acquired.treeEntries} entries). Eligible: ${eligibleFiles}; selected: ${acquired.sourceFiles}; omitted eligible files: ${omittedFiles}; analyzed: ${graph.scan.fileCount}; excluded or unsupported: ${acquired.skippedFiles}. ${partial ? "This is a partial assessment. Missing components and relationships cannot establish that a feature is absent." : "All eligible files were analyzed."}`);
    const manifest: InvestigationManifest = createManifest(graph, `${repo.owner}/${repo.repo}`);
    const graphJson = `${JSON.stringify(graph, null, 2)}\n`, manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    parseGraph(graphJson);
    return { artifact: { graphJson, manifestJson }, summary: { scannedFiles: graph.scan.fileCount, scannedBytes: graph.scan.totalBytes, eligibleFiles, selectedFiles: acquired.sourceFiles, omittedFiles, skippedFiles: acquired.skippedFiles, coverage: partial ? "partial-supported-source" : "complete-supported-source", nodes: graph.nodes.length, edges: graph.edges.length, warnings: graph.warnings.length } };
  }
  private validateWorkerSources(id: string, generation: string, scannerOutput: string): void {
    if (!this.handoff) throw new Error("Worker handoff is unavailable.");
    const manifest = readSnapshotManifest(this.handoff.roots, this.handoff.owners, id, generation);
    const allowed = new Set(manifest.files.map(file => file.path));
    const graph = parseGraph(scannerOutput);
    if ([...graph.nodes, ...graph.edges, ...(graph.rules ?? [])].some(item => !allowed.has(item.source.path))) throw new Error("Worker graph cites source outside the dispatched snapshot.");
  }

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
  create(url: string, privateContext?: { user: UserSession; authorized: AuthorizedRepository }, publicUser?: UserSession): GitHubJobStatus {
    this.sweep();
    const repo = parsePublicGitHubUrl(url);
    if (this.store.count() >= 3) throw new Error("Recent analysis capacity is full. Retry after jobs expire.");
    const quotaLease = this.quota.reserve({ scope: "scan_start", subject: privateContext?.user.id ?? publicUser?.id ?? "legacy-unowned", limit: 2, windowMs: 3_600_000, slot: "global_scan", leaseMs: 95_000 });
    const now = this.deps.now();
    const status: GitHubJobStatus = { id: randomUUID(), phase: "validating-repository-url", repository: `${repo.owner}/${repo.repo}`, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + EXPIRES_MS).toISOString() };
    const job: Job = { status, repo, controller: new AbortController(), leaseId: randomUUID(), quotaLease };
    if (privateContext) { const { user, authorized } = privateContext; job.owner = { id: user.id, nonce: user.nonce, installationId: authorized.installationId, repositoryId: authorized.id }; job.user = user; job.authorized = authorized; }
    else if (publicUser) job.owner = { id: publicUser.id, nonce: publicUser.nonce };
    try { this.store.create(status, repo, job.leaseId, job.owner, job.authorized?.private ? "private" : "public"); }
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
  createPublic(url: string, user: UserSession): GitHubJobStatus { return this.create(url, undefined, user); }
  private owned(job: { owner?: JobOwner } | undefined, user?: UserSession): boolean {
    return !!job && (!job.owner || !!user && job.owner.id === user.id && job.owner.nonce === user.nonce);
  }
  privateJob(id: string): boolean | undefined { this.sweep(); const job = this.store.get(id); return job ? job.kind === "private" : undefined; }
  ownedJob(id: string, user: UserSession): boolean { this.sweep(); const job = this.store.get(id); return !!job?.owner && this.owned(job, user); }
  private async run(job: Job) {
    let root: string | undefined;
    let completed: { artifact: Artifact; summary: NonNullable<GitHubJobStatus["summary"]> } | undefined;
    const deadline = setTimeout(() => { this.update(job, "failed", "GitHub analysis exceeded its 90-second deadline."); this.cancelHandoff(job.status.id); job.controller.abort(); }, 90_000);
    deadline.unref();
    const heartbeat = setInterval(() => {
      try { if (job.quotaLease && !this.quota.renew(job.quotaLease, 95_000)) { this.update(job, "failed", "Scan lease expired. Retry the analysis."); this.cancelHandoff(job.status.id); job.controller.abort(); } }
      catch { try { this.update(job, "failed", "Scan lease could not be renewed."); } catch { /* The scan is aborted if quota storage is unavailable. */ } this.cancelHandoff(job.status.id); job.controller.abort(); }
    }, 10_000);
    heartbeat.unref();
    const recordTiming = (values: Partial<GitHubJobDiagnostics>) => { job.status = { ...job.status, diagnostics: { selectedBlobs: 0, completedBlobs: 0, failedBlobs: 0, ...job.status.diagnostics, ...values } }; this.store.update(job.status.id, job.status, job.leaseId); };
    try {
      this.update(job, "preparing-isolated-scanner");
      let image: string | undefined;
      if (!this.handoff) { const readinessStarted = performance.now(); image = await this.deps.available(); recordTiming({ dockerReadinessMs: Math.round(performance.now() - readinessStarted) }); }
      if (job.controller.signal.aborted) return;
      root = await this.deps.temporary();
      this.update(job, "fetching-repository");
      let token: string | undefined;
      if (job.owner?.installationId && job.owner.repositoryId && job.user && job.authorized) {
        const fresh = await this.deps.authorize(job.user, job.owner.installationId, job.owner.repositoryId);
        if (!fresh || fresh.owner !== job.authorized.owner || fresh.name !== job.authorized.name) throw new Error("Repository authorization expired or was revoked.");
        token = await this.deps.token(fresh);
      }
      const acquired = await this.deps.acquire(job.repo, path.join(root, "repo"), job.controller.signal, undefined, token, diagnostics => recordTiming(diagnostics));
      if (job.controller.signal.aborted) return;
      this.update(job, "scanning-supported-source-files");
      const scanStarted = performance.now();
      const worker = this.handoff ? await this.workerOutput(job, root, acquired) : undefined;
      const scannerOutput = worker ? worker.output : await this.deps.scan(root, image!, job.controller.signal);
      recordTiming({ sandboxScanMs: Math.round(performance.now() - scanStarted) });
      if (job.controller.signal.aborted) return;
      this.update(job, "generating-architecture-graph");
      const graphStarted = performance.now();
      this.update(job, "validating-graph");
      completed = this.buildArtifacts(job.repo, job.authorized?.private ? "private" : "public", acquired, scannerOutput, !!this.handoff);
      recordTiming({ graphValidationMs: Math.round(performance.now() - graphStarted) });
      if (job.controller.signal.aborted) return;
    } catch (error) {
      this.cancelHandoff(job.status.id);
      if (!job.controller.signal.aborted) this.update(job, "failed", error instanceof Error ? error.message : "GitHub analysis failed.");
    } finally {
      clearTimeout(deadline);
      try {
        let cleaned = true;
        if (root) await this.deps.cleanup(root).catch(() => { cleaned = false; if (!job.controller.signal.aborted) this.update(job, "failed", "Temporary scanner cleanup failed."); });
        if (cleaned && completed && !job.controller.signal.aborted) {
          let authorized = true;
          if (job.owner?.installationId && job.owner.repositoryId && job.user) {
            const fresh = await this.deps.authorize(job.user, job.owner.installationId, job.owner.repositoryId).catch(() => null);
            if (!fresh || fresh.owner !== job.authorized?.owner || fresh.name !== job.authorized.name) { this.update(job, "failed", "Repository authorization expired or was revoked."); authorized = false; }
          }
          if (authorized) {
            const ready = { ...job.status, phase: "ready" as const, summary: completed.summary };
            try {
              const workerState = this.handoff ? this.dispatch.get(job.status.id) : undefined;
              if (this.handoff && (!workerState?.resultSha256 || workerState.cancelled)) throw new Error("Worker result identity is unavailable.");
              this.store.publish(job.status.id, job.leaseId, completed.artifact, ready, workerState ? { generation: workerState.generation, resultSha256: workerState.resultSha256! } : undefined);
              job.status = ready;
              if (workerState && this.handoff) { try { cleanupWebSpool(this.handoff.roots, this.handoff.owners, job.status.id, workerState.generation); } catch { /* Expiry cleanup will retry. */ } }
            }
            catch { this.cancelHandoff(job.status.id); this.update(job, "failed", "Could not publish validated scan artifacts."); }
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
  async authorizedStatus(id: string, user?: UserSession, currentSession?: () => Promise<UserSession | null>): Promise<GitHubJobStatus | undefined> {
    this.sweep(); const job = this.store.get(id);
    if (!job || !this.owned(job, user)) return undefined;
    const recovering = !!this.handoff && !this.live.has(id) && ["scanning-supported-source-files", "generating-architecture-graph", "validating-graph"].includes(job.status.phase);
    if (recovering) {
      await this.reconcileWorker(id, user, currentSession);
    } else if (job.kind === "private" && user && job.owner?.installationId && job.owner.repositoryId) {
      const fresh = await this.deps.authorize(user, job.owner.installationId, job.owner.repositoryId).catch(() => null);
      if (!fresh || fresh.id !== job.owner.repositoryId || fresh.installationId !== job.owner.installationId || fresh.owner !== job.repo.owner || fresh.name !== job.repo.repo) {
        this.live.get(id)?.controller.abort(); this.store.invalidate(id, job.status); return undefined;
      }
    }
    if (recovering && job.kind === "private" && this.store.get(id)?.status.error === "Repository authorization expired or was revoked.") return undefined;
    return this.store.get(id)?.status;
  }
  private async reconcileWorker(id: string, user?: UserSession, currentSession?: () => Promise<UserSession | null>): Promise<void> {
    if (!this.handoff) return;
    const job = this.store.get(id), state = this.dispatch.get(id);
    if (!job || !state || !state.source || !state.quotaLeaseId || state.cancelled || job.status.phase === "ready") return;
    const lease = { slot: "global_scan", id: state.quotaLeaseId };
    const fail = (reason: string) => {
      if (this.store.failWorker(id, job.leaseId, state.generation, reason)) {
        try { markCancelled(this.handoff!.roots, this.handoff!.owners, id, state.generation); } catch { /* Deadline and database deny publication. */ }
        this.quota.release(lease);
      }
    };
    const privateAccess = async (): Promise<boolean> => {
      if (job.kind !== "private") return true;
      if (!user || !this.owned(job, user) || !currentSession || !job.owner?.installationId || !job.owner.repositoryId) return false;
      const session = await currentSession().catch(() => null);
      if (!session || session.expiresAt <= this.deps.now() || session.id !== user.id || session.nonce !== user.nonce) return false;
      const repository = await this.deps.authorize(session, job.owner.installationId, job.owner.repositoryId).catch(() => null);
      return !!repository && repository.id === job.owner.repositoryId && repository.installationId === job.owner.installationId && repository.owner === job.repo.owner && repository.name === job.repo.repo;
    };
    if (!await privateAccess()) { fail("Repository authorization expired or was revoked."); return; }
    if (this.deps.now() >= state.deadline) { fail("Worker dispatch exceeded the job deadline."); return; }
    if (!this.quota.renew(lease, 95_000)) { fail("Scan lease expired. Retry the analysis."); return; }
    try {
      let acknowledged = !!state.acknowledgedAt;
      try {
        const receipt = readClaimReceipt(this.handoff.roots, this.handoff.owners, id, state.generation);
        if (receipt !== state.manifestSha256) throw new Error("Worker claim identity mismatch.");
        if (!acknowledged && !this.dispatch.acknowledge(id, state.generation, receipt)) throw new Error("Worker claim acknowledgement failed.");
        publishClaimAcknowledgement(this.handoff.roots, this.handoff.owners, id, state.generation, receipt);
        acknowledged = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!acknowledged) return;
      let output: string;
      try { output = readResult(this.handoff.roots, this.handoff.owners, id, state.generation); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; output = ""; }
      if (!output) {
        try { const beat = readWorkerHeartbeat(this.handoff.roots, this.handoff.owners, id, state.generation); if (this.deps.now() - beat > 5_000) throw new Error("Worker heartbeat expired."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || this.deps.now() - (state.acknowledgedAt ?? this.deps.now()) > 5_000) throw error; }
        return;
      }
      const hash = createHash("sha256").update(output).digest("hex");
      this.validateWorkerSources(id, state.generation, output);
      const completed = this.buildArtifacts(job.repo, job.kind, state.source, output, true);
      if (state.resultSha256 && state.resultSha256 !== hash || !state.resultSha256 && !this.dispatch.recordResult(id, state.generation, hash)) throw new Error("Worker result identity mismatch.");
      if (!await privateAccess()) { fail("Repository authorization expired or was revoked."); return; }
      const ready = { ...job.status, phase: "ready" as const, summary: completed.summary };
      this.store.publish(id, job.leaseId, completed.artifact, ready, { generation: state.generation, resultSha256: hash });
      this.quota.release(lease);
      try { cleanupWebSpool(this.handoff.roots, this.handoff.owners, id, state.generation); } catch { /* Expiry cleanup remains available. */ }
    } catch { if (this.store.get(id)?.status.phase !== "ready") fail("Worker result could not be safely reconciled."); }
  }
  async artifact(id: string, name: "graph.json" | "manifest.json", user?: UserSession): Promise<string | undefined> {
    this.sweep(); const job = this.store.get(id);
    if (!job || !this.owned(job, user) || job.status.phase !== "ready") return undefined;
    if (job.owner?.installationId && job.owner.repositoryId && user && !await this.deps.authorize(user, job.owner.installationId, job.owner.repositoryId).catch(() => null)) { this.store.invalidate(id, job.status); return undefined; }
    return this.store.artifact(id, name);
  }
  cancel(id: string, user?: UserSession): GitHubJobStatus | undefined {
    this.sweep(); const job = this.store.get(id); if (!job || !this.owned(job, user)) return undefined;
    if (job.status.phase !== "ready" && job.status.phase !== "failed") {
      const dispatch = this.handoff && !this.live.has(id) ? this.dispatch.get(id) : undefined;
      this.cancelHandoff(id); this.live.get(id)?.controller.abort();
      const status = { ...job.status, phase: "cancelled" as const }; this.store.cancel(id, status);
      if (dispatch?.quotaLeaseId) this.quota.release({ slot: "global_scan", id: dispatch.quotaLeaseId });
      return status;
    }
    return job.status;
  }
  async wait(id: string): Promise<void> { await this.live.get(id)?.work; }
}

const singletonKey = Symbol.for("codearchaeologist.github-ingestion.jobs");
const shared = globalThis as typeof globalThis & { [singletonKey]?: GitHubJobManager };
export const githubJobs = shared[singletonKey] ??= new GitHubJobManager();
