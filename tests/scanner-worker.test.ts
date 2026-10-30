import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));
import { assertWorkerEnvironment, runWorkerJob, type WorkerConfig, type WorkerDependencies } from "../src/lib/github-ingestion/scanner-worker";
import { cleanupWorkerSpool, markCancelled, publishClaimAcknowledgement, publishSnapshot, readClaimReceipt, readResult } from "../src/lib/github-ingestion/spool";

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
