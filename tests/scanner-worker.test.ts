import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));
import { assertWorkerEnvironment, classifyWorkerFailure, reportWorkerFailure, runWorkerJob, workerCategoryFromExitCode, WORKER_EXIT_CODES, type WorkerConfig, type WorkerDependencies } from "../src/lib/github-ingestion/scanner-worker";
import { cleanupWorkerSpool, markCancelled, publishClaimAcknowledgement, publishSnapshot, readClaimReceipt, readResult, readWorkerFailure, WORKER_FAILURE_CATEGORIES } from "../src/lib/github-ingestion/spool";

let root: string, config: WorkerConfig, job: string, generation: string;
const source = [{ path: "src/Auth.php", bytes: Buffer.from("<?php class Auth {}") }];
const image = `sha256:${"a".repeat(64)}`;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-worker-test-")); job = randomUUID(); generation = randomUUID();
  const roots = { inbox: path.join(root, "inbox"), snapshots: path.join(root, "snapshots"), claims: path.join(root, "claims"), outbox: path.join(root, "outbox") };
  for (const dir of Object.values(roots)) mkdirSync(dir, { mode: 0o750 });
  chmodSync(roots.claims, 0o700);
  const scanRoot = path.join(root, "worker-private"); mkdirSync(scanRoot, { mode: 0o700 });
  const uid = process.getuid!(), gid = process.getgid!();
  config = { roots, scanRoot, owners: { webUid: uid, workerUid: uid, workerGid: gid, inboxGid: gid, outboxGid: gid } };
  publishSnapshot(roots, config.owners, job, generation, source, Date.now() + 60_000);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const mock = (sleep: WorkerDependencies["sleep"] = async () => {}): WorkerDependencies => ({
  available: vi.fn(async () => image),
  scan: vi.fn(async (scanRoot, fixedImage, signal) => {
    expect(fixedImage).toBe(image); expect(signal.aborted).toBe(false);
    expect(readFileSync(path.join(scanRoot, "repo/src/Auth.php"), "utf8")).toBe(source[0].bytes.toString());
    return '{"schemaVersion":"1.0.0"}';
  }), now: Date.now, sleep,
});
const approve = () => publishClaimAcknowledgement(config.roots, config.owners, job, generation, readClaimReceipt(config.roots, config.owners, job, generation));

describe("standalone scanner worker", () => {
  it("waits for web acknowledgement, copies verified source, then publishes a bounded result", async () => {
    const deps = mock(async () => { expect(deps.available).not.toHaveBeenCalled(); approve(); });
    await runWorkerJob(config, job, generation, deps);
    expect(deps.scan).toHaveBeenCalledOnce();
    expect(readResult(config.roots, config.owners, job, generation)).toContain("schemaVersion");
    await expect(runWorkerJob(config, job, generation, deps)).rejects.toThrow();
    expect(readFileSync(path.join(config.roots.outbox, `${job}.${generation}.claim`), "utf8")).not.toContain("<?php");
    cleanupWorkerSpool(config.roots, config.owners, job, generation);
  });

  it("never invokes Docker before acknowledgement and fails closed on cancellation", async () => {
    const deps = mock(async () => { markCancelled(config.roots, config.owners, job, generation); });
    await expect(runWorkerJob(config, job, generation, deps)).rejects.toThrow(/cancelled/);
    expect(deps.available).not.toHaveBeenCalled(); expect(deps.scan).not.toHaveBeenCalled();
  });

  it("rejects cancellation during execution and publishes no result", async () => {
    const deps = mock(async () => { approve(); });
    deps.scan = vi.fn(async () => { markCancelled(config.roots, config.owners, job, generation); return "{}"; });
    await expect(runWorkerJob(config, job, generation, deps)).rejects.toThrow(/cancelled/);
    expect(() => readResult(config.roots, config.owners, job, generation)).toThrow();
  });

  it("rejects a changed source file during worker-side copying", async () => {
    const deps = mock(async () => { approve(); rmSync(path.join(config.roots.snapshots, `${job}.${generation}`, "src/Auth.php")); symlinkSync("/etc/passwd", path.join(config.roots.snapshots, `${job}.${generation}`, "src/Auth.php")); });
    await expect(runWorkerJob(config, job, generation, deps)).rejects.toThrow();
    expect(deps.available).not.toHaveBeenCalled();
  });

  it("rejects inherited web/provider secrets and an invalid worker-owned scan root", async () => {
    expect(() => assertWorkerEnvironment({ CODEARCH_DB_PATH: "/private/db" })).toThrow(/credentials/);
    expect(() => assertWorkerEnvironment({ BASETEN_API_KEY: "configured" })).toThrow(/credentials/);
    const deps = mock(async () => { approve(); });
    chmodSync(config.scanRoot, 0o755);
    await expect(runWorkerJob(config, job, generation, deps)).rejects.toThrow(/private/);
    expect(deps.available).not.toHaveBeenCalled();
  });
});

describe("worker failure classification", () => {
  it.each([
    ["Scanner dispatch expired or was cancelled before acknowledgement.", "cancelled"],
    ["Scanner dispatch expired or was cancelled during preparation.", "cancelled"],
    ["Scanner dispatch expired or was cancelled before execution.", "cancelled"],
    ["Scanner dispatch expired or was cancelled during execution.", "cancelled"],
    ["GitHub analysis cancelled.", "cancelled"],
    ["Dispatch cancelled during claim.", "cancelled"],
    ["Result is stale or cancelled.", "cancelled"],
    ["Invalid, stale, or cancelled dispatch.", "cancelled"],
    ["Snapshot manifest integrity failed.", "snapshot-integrity"],
    ["Source snapshot changed after claim.", "snapshot-integrity"],
    ["Invalid claim acknowledgement.", "snapshot-integrity"],
    ["Unsafe source file.", "snapshot-integrity"],
    ["Malformed spool record.", "snapshot-integrity"],
    ["Isolated scanner unavailable: Docker daemon cannot be reached.", "docker-unavailable"],
    ["Isolated scanner unavailable: Docker seccomp enforcement could not be verified. Enable the built-in profile for scanner containers.", "docker-unavailable"],
    ["Invalid scanner image identity.", "docker-unavailable"],
    ["Isolated scanner failed. Check Docker availability and scanner limits.", "scan-failed"],
    ["Isolated scanner exceeded its 30-second limit.", "scan-timeout"],
    ["Claim is not acknowledged.", "result-rejected"],
    ["Scanner result envelope exceeds limit.", "result-rejected"],
    ["Isolated scanner cleanup could not be confirmed.", "cleanup-unconfirmed"],
    ["Worker scan root must be private.", "internal"],
    ["Spool writer identity mismatch.", "internal"],
    ["Scanner worker environment contains web or provider credentials.", "internal"],
  ])("classifies %s as %s", (message, category) => {
    expect(classifyWorkerFailure(new Error(message))).toBe(category);
  });

  it("falls back to internal for system errors, unknown errors, and non-errors", () => {
    expect(classifyWorkerFailure(Object.assign(new Error("ENOENT: no such file or directory, open '/spool/inbox/x'"), { code: "ENOENT" }))).toBe("internal");
    expect(classifyWorkerFailure(new Error("boom"))).toBe("internal");
    expect(classifyWorkerFailure(null)).toBe("internal");
    expect(classifyWorkerFailure("string failure")).toBe("internal");
    expect(classifyWorkerFailure(new Error("__proto__"))).toBe("internal");
  });

  it("round-trips every category through exit codes with an internal fallback", () => {
    expect(new Set(Object.values(WORKER_EXIT_CODES)).size).toBe(WORKER_FAILURE_CATEGORIES.length);
    for (const category of WORKER_FAILURE_CATEGORIES) {
      expect(workerCategoryFromExitCode(WORKER_EXIT_CODES[category])).toBe(category);
    }
    expect(WORKER_EXIT_CODES.internal).toBe(1);
    expect(workerCategoryFromExitCode(0)).toBe("internal");
    expect(workerCategoryFromExitCode(99)).toBe("internal");
    expect(workerCategoryFromExitCode(null)).toBe("internal");
  });

  it("publishes the classified category without throwing when publication is impossible", async () => {
    const deps = mock(async () => { approve(); });
    deps.scan = vi.fn(async () => { throw new Error("Isolated scanner exceeded its 30-second limit."); });
    const failure = await runWorkerJob(config, job, generation, deps).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(reportWorkerFailure(config, job, generation, failure)).toBe("scan-timeout");
    expect(readWorkerFailure(config.roots, config.owners, job, generation).category).toBe("scan-timeout");
    expect(reportWorkerFailure(config, job, generation, new Error("boom"))).toBe("internal");
    const unclaimed = { job: randomUUID(), generation: randomUUID() };
    publishSnapshot(config.roots, config.owners, unclaimed.job, unclaimed.generation, source, Date.now() + 60_000);
    expect(reportWorkerFailure(config, unclaimed.job, unclaimed.generation, new Error("boom"))).toBe("internal");
  });
});
