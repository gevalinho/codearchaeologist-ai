import "server-only";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SCAN_LIMITS } from "../archaeology/selection";
import { acknowledgedClaim, claimDispatch, isCancelled, publishResult, publishWorkerFailure, publishWorkerHeartbeat, validId, validateSpoolRoots, type SnapshotManifest, type SpoolOwners, type SpoolRoots, type WorkerFailureCategory } from "./spool";
import { runIsolatedScanner, scannerAvailable } from "./sandbox";

export type WorkerConfig = { roots: SpoolRoots; owners: SpoolOwners; scanRoot: string };
export type WorkerDependencies = { available: () => Promise<string>; scan: (root: string, image: string, signal: AbortSignal) => Promise<string>; now: () => number; sleep: (ms: number) => Promise<void> };
const defaults: WorkerDependencies = { available: scannerAvailable, scan: runIsolatedScanner, now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
const prohibited = ["CODEARCH_DB_PATH", "CODEARCH_TOKEN_ENCRYPTION_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_SESSION_SECRET", "BASETEN_API_KEY", "META_API_KEY", "MODEL_API_KEY", "FEATURE_AI_ACCESS_KEY"];

/** A worker process must start with an isolated environment, never the web service environment. */
export function assertWorkerEnvironment(environment: Record<string, string | undefined> = process.env): void {
  const present = prohibited.some(key => environment[key] !== undefined) || Object.keys(environment).some(key => /^GITHUB_(?:APP_|TOKEN|ACCESS_TOKEN)/.test(key));
  if (present) throw new Error("Scanner worker environment contains web or provider credentials.");
}

function privateScanRoot(root: string, uid: number): void {
  if (!path.isAbsolute(root) || root === "/" || root.includes("\0")) throw new Error("Invalid worker scan root.");
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(root) !== root || info.uid !== uid || info.mode & 0o077) throw new Error("Worker scan root must be private.");
}

/** Copy only manifest-listed files, rehashing opened source descriptors before the scanner sees them. */
export function copyVerifiedSnapshot(snapshot: string, manifest: SnapshotManifest, config: WorkerConfig): string {
  validateSpoolRoots(config.roots, config.owners);
  if (typeof process.getuid !== "function" || process.getuid() !== config.owners.workerUid) throw new Error("Worker identity mismatch.");
  privateScanRoot(config.scanRoot, config.owners.workerUid);
  const snapshotInfo = lstatSync(snapshot);
  if (!snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink() || realpathSync(snapshot) !== snapshot || snapshotInfo.uid !== config.owners.webUid || snapshotInfo.gid !== config.owners.inboxGid || snapshotInfo.mode & 0o027) throw new Error("Unsafe source snapshot root.");
  const runRoot = mkdtempSync(path.join(config.scanRoot, "codearch-worker-"));
  const repo = path.join(runRoot, "repo");
  try {
    mkdirSync(repo, { mode: 0o755 });
    let total = 0;
    for (const file of manifest.files) {
      const relative = file.path.split("/");
      let sourceParent = snapshot, targetParent = repo;
      for (const part of relative.slice(0, -1)) {
        sourceParent = path.join(sourceParent, part);
        const info = lstatSync(sourceParent);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== config.owners.webUid || info.gid !== config.owners.inboxGid || info.mode & 0o027) throw new Error("Unsafe source directory.");
        targetParent = path.join(targetParent, part);
        try { mkdirSync(targetParent, { mode: 0o755 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const sourceFd = openSync(path.join(sourceParent, relative.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const info = fstatSync(sourceFd);
        if (!info.isFile() || info.nlink !== 1 || info.uid !== config.owners.webUid || info.gid !== config.owners.inboxGid || info.mode & 0o027 || info.size !== file.bytes || info.size < 0 || info.size > DEFAULT_SCAN_LIMITS.maxFileBytes) throw new Error("Unsafe source file.");
        bytes = readFileSync(sourceFd);
      } finally { closeSync(sourceFd); }
      if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Source snapshot changed after claim.");
      total += bytes.length;
      if (total > DEFAULT_SCAN_LIMITS.maxTotalBytes) throw new Error("Source snapshot exceeds byte limit.");
      const targetFd = openSync(path.join(targetParent, relative.at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try { writeFileSync(targetFd, bytes); } finally { closeSync(targetFd); }
    }
    if (total !== manifest.totalBytes) throw new Error("Source snapshot byte count changed.");
    return runRoot;
  } catch (error) { rmSync(runRoot, { recursive: true, force: true }); throw error; }
}

/** Worker process exit codes by failure category. 0 is success; unknown codes mean internal. */
export const WORKER_EXIT_CODES: Record<WorkerFailureCategory, number> = { cancelled: 2, "snapshot-integrity": 3, "docker-unavailable": 4, "scan-failed": 5, "scan-timeout": 6, "result-rejected": 7, "cleanup-unconfirmed": 8, internal: 1 };
const categoryByExitCode = new Map<number, WorkerFailureCategory>(Object.entries(WORKER_EXIT_CODES).map(([category, code]) => [code, category as WorkerFailureCategory]));
export function workerCategoryFromExitCode(code: number | null): WorkerFailureCategory { return code === null ? "internal" : (categoryByExitCode.get(code) ?? "internal"); }

/**
 * Classify a worker error into the fixed failure allowlist by exact match on
 * known fixed literals. System errors (which embed paths) and unknown errors
 * fall through to internal, so classification can never leak sensitive text.
 * "Invalid, stale, or cancelled dispatch." conflates claim causes by design;
 * it maps to cancelled, the routine production case.
 */
const categoryByMessage = new Map<string, WorkerFailureCategory>([
  ["Scanner dispatch expired or was cancelled before acknowledgement.", "cancelled"],
  ["Scanner dispatch expired or was cancelled during preparation.", "cancelled"],
  ["Scanner dispatch expired or was cancelled before execution.", "cancelled"],
  ["Scanner dispatch expired or was cancelled during execution.", "cancelled"],
  ["GitHub analysis cancelled.", "cancelled"],
  ["Dispatch cancelled during claim.", "cancelled"],
  ["Result is stale or cancelled.", "cancelled"],
  ["Invalid, stale, or cancelled dispatch.", "cancelled"],
  ["Snapshot manifest integrity failed.", "snapshot-integrity"],
  ["Snapshot contains a symlink.", "snapshot-integrity"],
  ["Snapshot contains an unexpected entry.", "snapshot-integrity"],
  ["Snapshot is incomplete.", "snapshot-integrity"],
  ["Invalid snapshot manifest.", "snapshot-integrity"],
  ["Invalid snapshot file record.", "snapshot-integrity"],
  ["Snapshot byte count mismatch.", "snapshot-integrity"],
  ["Source snapshot integrity failed.", "snapshot-integrity"],
  ["Source snapshot changed after claim.", "snapshot-integrity"],
  ["Source snapshot exceeds byte limit.", "snapshot-integrity"],
  ["Source snapshot byte count changed.", "snapshot-integrity"],
  ["Invalid claim acknowledgement.", "snapshot-integrity"],
  ["Unsafe source snapshot root.", "snapshot-integrity"],
  ["Unsafe source directory.", "snapshot-integrity"],
  ["Unsafe source file.", "snapshot-integrity"],
  ["Unsafe spool file.", "snapshot-integrity"],
  ["Malformed spool record.", "snapshot-integrity"],
  ["Invalid spool identifier.", "snapshot-integrity"],
  ["Unsafe spool directory permissions.", "internal"],
  ["Spool writer identity mismatch.", "internal"],
  ["Spool roots must be distinct.", "internal"],
  ["Invalid spool root.", "internal"],
  ["Worker identity mismatch.", "internal"],
  ["Invalid worker scan root.", "internal"],
  ["Worker scan root must be private.", "internal"],
  ["Scanner worker environment contains web or provider credentials.", "internal"],
  ["Isolated scanner unavailable: production worker identity is not verified.", "docker-unavailable"],
  ["Isolated scanner unavailable: invalid rootless Docker configuration.", "docker-unavailable"],
  ["Isolated scanner unavailable: Docker daemon cannot be reached.", "docker-unavailable"],
  ["Isolated scanner unavailable: Docker security options are unreadable.", "docker-unavailable"],
  ["Isolated scanner unavailable: Docker does not report seccomp support.", "docker-unavailable"],
  ["Isolated scanner unavailable: trusted local Node image is missing.", "docker-unavailable"],
  ["Isolated scanner unavailable: Docker seccomp enforcement could not be verified. Enable the built-in profile for scanner containers.", "docker-unavailable"],
  ["Invalid scanner image identity.", "docker-unavailable"],
  ["Isolated scanner failed. Check Docker availability and scanner limits.", "scan-failed"],
  ["Isolated scanner exceeded its 30-second limit.", "scan-timeout"],
  ["Claim is not acknowledged.", "result-rejected"],
  ["Scanner result exceeds limit.", "result-rejected"],
  ["Scanner result envelope exceeds limit.", "result-rejected"],
  ["Isolated scanner cleanup could not be confirmed.", "cleanup-unconfirmed"],
]);
export function classifyWorkerFailure(error: unknown): WorkerFailureCategory {
  if (error instanceof Error) return categoryByMessage.get(error.message) ?? "internal";
  return "internal";
}

/** Best-effort terminal failure publication. Never throws and never logs; the exit code still carries the category when publication is impossible. */
export function reportWorkerFailure(config: WorkerConfig, jobId: string, generation: string, error: unknown): WorkerFailureCategory {
  const category = classifyWorkerFailure(error);
  try { publishWorkerFailure(config.roots, config.owners, jobId, generation, category); } catch { /* Terminal diagnostics only. */ }
  return category;
}

/** One dispatch attempt only. A persisted claim is never removed or retried by this runtime. */
export async function runWorkerJob(config: WorkerConfig, jobId: string, generation: string, deps: WorkerDependencies = defaults): Promise<void> {
  assertWorkerEnvironment(); validId(jobId); validId(generation);
  const claimed = claimDispatch(config.roots, config.owners, jobId, generation, deps.now());
  const controller = new AbortController();
  let scanRoot: string | undefined;
  const check = () => {
    if (deps.now() >= claimed.dispatch.deadline || isCancelled(config.roots, config.owners, jobId, generation)) controller.abort();
    return !controller.signal.aborted;
  };
  const heartbeat = () => {
    try { if (check()) publishWorkerHeartbeat(config.roots, config.owners, jobId, generation, deps.now()); }
    catch { controller.abort(); }
  };
  const interval = setInterval(heartbeat, 1_000);
  try {
    heartbeat();
    while (check() && !acknowledgedClaim(config.roots, config.owners, jobId, generation, claimed.dispatch.manifestSha256)) {
      await deps.sleep(200);
    }
    if (!check()) throw new Error("Scanner dispatch expired or was cancelled before acknowledgement.");
    scanRoot = copyVerifiedSnapshot(claimed.snapshot, claimed.manifest, config);
    if (!check()) throw new Error("Scanner dispatch expired or was cancelled during preparation.");
    const image = await deps.available();
    if (!check()) throw new Error("Scanner dispatch expired or was cancelled before execution.");
    const output = await deps.scan(scanRoot, image, controller.signal);
    if (!check()) throw new Error("Scanner dispatch expired or was cancelled during execution.");
    publishResult(config.roots, config.owners, jobId, generation, output);
  } finally {
    clearInterval(interval); controller.abort();
    if (scanRoot) rmSync(scanRoot, { recursive: true, force: true });
  }
}
