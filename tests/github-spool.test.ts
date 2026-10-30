import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));
import { acknowledgedClaim, claimDispatch, cleanupWebSpool, cleanupWorkerSpool, isCancelled, markCancelled, publishClaimAcknowledgement, publishResult, publishSnapshot, publishWorkerHeartbeat, readClaimReceipt, readResult, readWorkerHeartbeat, validId, type SpoolOwners, type SpoolRoots } from "../src/lib/github-ingestion/spool";

let root: string, roots: SpoolRoots, owners: SpoolOwners;
const id = () => randomUUID();
const source = () => [{ path: "src/Auth.php", bytes: Buffer.from("<?php class Auth {}") }];
const snapshot = (job: string, generation: string) => path.join(roots.snapshots, `${job}.${generation}`);
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-spool-"));
  roots = { inbox: path.join(root, "inbox"), snapshots: path.join(root, "snapshots"), claims: path.join(root, "claims"), outbox: path.join(root, "outbox") };
  for (const dir of Object.values(roots)) mkdirSync(dir, { mode: 0o750 });
  chmodSync(roots.claims, 0o700);
  owners = { webUid: process.getuid!(), workerUid: process.getuid!(), workerGid: process.getgid!(), inboxGid: process.getgid!(), outboxGid: process.getgid!() };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("isolated scanner spool foundation", () => {
  it("publishes a bounded snapshot, claims once, and verifies a result", () => {
    const job = id(), generation = id();
    const dispatch = publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    expect(dispatch.jobId).toBe(job);
    expect(claimDispatch(roots, owners, job, generation).manifest.files).toHaveLength(1);
    const receipt = readClaimReceipt(roots, owners, job, generation);
    expect(acknowledgedClaim(roots, owners, job, generation, receipt)).toBe(false);
    publishClaimAcknowledgement(roots, owners, job, generation, receipt);
    expect(acknowledgedClaim(roots, owners, job, generation, receipt)).toBe(true);
    publishWorkerHeartbeat(roots, owners, job, generation);
    expect(readWorkerHeartbeat(roots, owners, job, generation)).toBeGreaterThan(0);
    expect(() => claimDispatch(roots, owners, job, generation)).toThrow();
    publishResult(roots, owners, job, generation, '{"schemaVersion":"1.0.0"}');
    expect(readResult(roots, owners, job, generation)).toContain("schemaVersion");
    cleanupWorkerSpool(roots, owners, job, generation);
    cleanupWebSpool(roots, owners, job, generation);
  });

  it("rejects malformed identifiers, traversal, sensitive paths, and oversized source", () => {
    expect(() => validId("../etc/passwd")).toThrow();
    expect(() => validId("A".repeat(36))).toThrow();
    const job = id(), generation = id();
    expect(() => publishSnapshot(roots, owners, job, generation, [{ path: "../secret.php", bytes: Buffer.from("x") }], Date.now() + 60_000)).toThrow();
    expect(() => publishSnapshot(roots, owners, job, generation, [{ path: ".env", bytes: Buffer.from("x") }], Date.now() + 60_000)).toThrow();
    expect(() => publishSnapshot(roots, owners, job, generation, [{ path: "src/large.php", bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }], Date.now() + 60_000)).toThrow();
  });

  it("rejects symlinks, extra files, and tampered source before a claim", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    const dir = snapshot(job, generation);
    symlinkSync("/etc/passwd", path.join(dir, "src", "other.php"));
    expect(() => claimDispatch(roots, owners, job, generation)).toThrow(/symlink/);
    rmSync(path.join(dir, "src", "other.php"));
    writeFileSync(path.join(dir, "src", "extra.php"), "extra");
    expect(() => claimDispatch(roots, owners, job, generation)).toThrow(/unexpected/);
    rmSync(path.join(dir, "src", "extra.php"));
    writeFileSync(path.join(dir, "src", "Auth.php"), "tampered");
    expect(() => claimDispatch(roots, owners, job, generation)).toThrow(/integrity/);
  });

  it("rejects hard links, altered manifests, and incomplete dispatch writes", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    const file = path.join(snapshot(job, generation), "src", "Auth.php");
    linkSync(file, path.join(root, "linked.php"));
    expect(() => claimDispatch(roots, owners, job, generation)).toThrow(/Unsafe spool file/);
    rmSync(path.join(root, "linked.php"));
    writeFileSync(path.join(snapshot(job, generation), "manifest.json"), "{}");
    expect(() => claimDispatch(roots, owners, job, generation)).toThrow(/integrity/);
    const second = id(), secondGeneration = id();
    writeFileSync(path.join(roots.inbox, `${second}.${secondGeneration}.json`), "{");
    expect(() => claimDispatch(roots, owners, second, secondGeneration)).toThrow(/Malformed|Unsafe/);
  });

  it("rejects cancelled and stale generations, including late results", () => {
    const job = id(), first = id(), second = id();
    publishSnapshot(roots, owners, job, first, source(), Date.now() + 60_000);
    claimDispatch(roots, owners, job, first);
    markCancelled(roots, owners, job, first);
    expect(isCancelled(roots, owners, job, first)).toBe(true);
    expect(() => publishResult(roots, owners, job, first, "{}" )).toThrow(/cancelled/);
    publishSnapshot(roots, owners, job, second, source(), Date.now() + 60_000);
    expect(() => claimDispatch(roots, owners, job, first)).toThrow(/stale/);
    expect(claimDispatch(roots, owners, job, second).dispatch.generation).toBe(second);
  });

  it("rejects substituted acknowledgement identities and cancellation after acknowledgement", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    claimDispatch(roots, owners, job, generation);
    const receipt = readClaimReceipt(roots, owners, job, generation);
    expect(() => publishClaimAcknowledgement(roots, owners, job, generation, "b".repeat(64))).toThrow(/mismatch/);
    publishClaimAcknowledgement(roots, owners, job, generation, receipt);
    expect(() => acknowledgedClaim(roots, owners, job, generation, "b".repeat(64))).toThrow(/Invalid/);
    markCancelled(roots, owners, job, generation);
    expect(acknowledgedClaim(roots, owners, job, generation, receipt)).toBe(false);
    expect(() => publishResult(roots, owners, job, generation, "{}")).toThrow(/cancelled/);
  });

  it("rejects tampered results and unsafe spool roots", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    claimDispatch(roots, owners, job, generation);
    const receipt = readClaimReceipt(roots, owners, job, generation);
    expect(() => publishResult(roots, owners, job, generation, "{}")).toThrow(/acknowledged/);
    publishClaimAcknowledgement(roots, owners, job, generation, receipt);
    publishResult(roots, owners, job, generation, "{}");
    const result = path.join(roots.outbox, `${job}.${generation}.json`);
    const body = JSON.parse(readFileSync(result, "utf8"));
    writeFileSync(result, JSON.stringify({ ...body, graphJson: "changed" }));
    expect(() => readResult(roots, owners, job, generation)).toThrow(/integrity/);
    chmodSync(roots.inbox, 0o777);
    expect(() => isCancelled(roots, owners, job, generation)).toThrow(/permissions/);
  });

  it("rejects missing source files and symlinked roots", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    rmSync(path.join(snapshot(job, generation), "src", "Auth.php"));
    expect(() => claimDispatch(roots, owners, job, generation)).toThrow(/incomplete/);
    const alias = path.join(root, "alias");
    symlinkSync(roots.inbox, alias);
    expect(() => isCancelled({ ...roots, inbox: alias }, owners, job, generation)).toThrow(/permissions/);
  });
});
