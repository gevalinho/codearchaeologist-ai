import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { linkObservations, watchedPaths, contentObservations, fdPaths, nlinkInjections } = vi.hoisted(() => ({
  linkObservations: [] as number[],
  watchedPaths: [] as string[],
  contentObservations: [] as { path: string; bytes: string }[],
  fdPaths: new Map<number, string>(),
  nlinkInjections: new Map<string, number>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // Forced interleaving: after every visibility-changing call, read each
  // watched path exactly as a concurrent reader arriving at that instant would.
  const observe = () => {
    for (const watched of watchedPaths) {
      try { contentObservations.push({ path: watched, bytes: actual.readFileSync(watched).toString("utf8") }); }
      catch { /* Absent: a concurrent reader would retry or wait. */ }
    }
  };
  return {
    ...actual,
    // Worst-case-timed reader: observe the target link count immediately after
    // every hard-link call, exactly when a concurrent readSafe() could run.
    linkSync: (...args: [existingPath: PathLike, newPath: PathLike]): void => {
      actual.linkSync(...args);
      linkObservations.push(actual.lstatSync(args[1]).nlink);
    },
    openSync: (...args: [path: PathLike, flags: number, mode?: number]): number => {
      try {
        const fd = actual.openSync(...args);
        fdPaths.set(fd, String(args[0]));
        return fd;
      } finally { observe(); }
    },
    fstatSync: (fd: number) => {
      const info = actual.fstatSync(fd);
      const target = fdPaths.get(fd);
      const remaining = target === undefined ? undefined : nlinkInjections.get(target);
      if (target !== undefined && remaining !== undefined && remaining > 0) {
        nlinkInjections.set(target, remaining - 1);
        info.nlink = 2;
      }
      return info;
    },
    closeSync: (fd: number): void => {
      try { actual.closeSync(fd); } finally { fdPaths.delete(fd); }
    },
    renameSync: (...args: [oldPath: PathLike, newPath: PathLike]): void => {
      try { actual.renameSync(...args); } finally { observe(); }
    },
  };
});

import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
const actualRead = (file: string) => readFileSync(file, "utf8");
import { acknowledgedClaim, claimDispatch, isCancelled, markCancelled, publishClaimAcknowledgement, publishResult, publishSnapshot, publishWorkerHeartbeat, readClaimReceipt, readResult, readWorkerHeartbeat, READ_SAFE_NLINK_RETRIES, type SpoolOwners, type SpoolRoots } from "../src/lib/github-ingestion/spool";

let root: string, roots: SpoolRoots, owners: SpoolOwners;
const id = () => randomUUID();
const source = () => [{ path: "src/Auth.php", bytes: Buffer.from("<?php class Auth {}") }];
const published = (job: string, generation: string) => [
  path.join(roots.inbox, `${job}.${generation}.json`),
  path.join(roots.outbox, `${job}.${generation}.claim`),
  path.join(roots.inbox, `${job}.${generation}.ack`),
  path.join(roots.outbox, `${job}.${generation}.json`),
  path.join(roots.outbox, `${job}.${generation}.heartbeat`),
];
beforeEach(() => {
  linkObservations.length = 0;
  watchedPaths.length = 0;
  contentObservations.length = 0;
  fdPaths.clear();
  nlinkInjections.clear();
  root = mkdtempSync(path.join(tmpdir(), "codearch-spool-publish-"));
  roots = { inbox: path.join(root, "inbox"), snapshots: path.join(root, "snapshots"), claims: path.join(root, "claims"), outbox: path.join(root, "outbox") };
  for (const dir of Object.values(roots)) mkdirSync(dir, { mode: 0o750 });
  chmodSync(roots.claims, 0o700);
  owners = { webUid: process.getuid!(), workerUid: process.getuid!(), workerGid: process.getgid!(), inboxGid: process.getgid!(), outboxGid: process.getgid!() };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("atomic spool publication", () => {
  it("publishes records through transient hard links that settle to a single link", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    claimDispatch(roots, owners, job, generation);
    const receipt = readClaimReceipt(roots, owners, job, generation);
    publishClaimAcknowledgement(roots, owners, job, generation, receipt);
    publishWorkerHeartbeat(roots, owners, job, generation);
    publishResult(roots, owners, job, generation, '{"schemaVersion":"1.0.0"}');
    expect(readResult(roots, owners, job, generation)).toContain("schemaVersion");
    const cancelJob = id(), cancelGeneration = id();
    publishSnapshot(roots, owners, cancelJob, cancelGeneration, source(), Date.now() + 60_000);
    markCancelled(roots, owners, cancelJob, cancelGeneration);
    // Deterministic: each of the six publications passed through the link
    // window (observed at nlink 2 inside the mocked call), and every record
    // settled to exactly one link with publication permissions.
    expect(linkObservations).toHaveLength(6);
    expect(linkObservations.every(nlink => nlink === 2)).toBe(true);
    for (const file of [...published(job, generation), path.join(roots.inbox, `${cancelJob}.${cancelGeneration}.cancel`)]) {
      const info = lstatSync(file);
      expect(info.isFile()).toBe(true);
      expect(info.nlink).toBe(1);
      expect(info.mode & 0o777).toBe(0o640);
    }
    for (const dir of [roots.inbox, roots.outbox]) expect(readdirSync(dir).filter(entry => entry.includes(".tmp"))).toEqual([]);
  });

  it("never exposes a partially written publication to concurrent readers", () => {
    const job = id(), generation = id(), cancelJob = id(), cancelGeneration = id();
    // Single-version publishFile targets only; heartbeat and active markers
    // are intentionally multi-version rename paths with different content.
    const targets = [
      path.join(roots.inbox, `${job}.${generation}.json`),
      path.join(roots.outbox, `${job}.${generation}.claim`),
      path.join(roots.inbox, `${job}.${generation}.ack`),
      path.join(roots.outbox, `${job}.${generation}.json`),
      path.join(roots.inbox, `${cancelJob}.${cancelGeneration}.cancel`),
    ];
    watchedPaths.push(...targets);
    try {
      publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
      claimDispatch(roots, owners, job, generation);
      const receipt = readClaimReceipt(roots, owners, job, generation);
      publishClaimAcknowledgement(roots, owners, job, generation, receipt);
      publishResult(roots, owners, job, generation, '{"schemaVersion":"1.0.0"}');
      publishSnapshot(roots, owners, cancelJob, cancelGeneration, source(), Date.now() + 60_000);
      markCancelled(roots, owners, cancelJob, cancelGeneration);
    } finally { watchedPaths.length = 0; }
    // Deterministic: every observation equals the final content, so no reader
    // arriving at any syscall boundary could see an empty or partial file.
    // Direct O_EXCL publication fails here: the target is observed empty
    // immediately after creation, before any byte is written.
    const finals = new Map(targets.map(target => [target, actualRead(target)]));
    expect(contentObservations.length).toBeGreaterThan(0);
    expect(new Set(contentObservations.map(entry => entry.path))).toEqual(new Set(targets));
    for (const entry of contentObservations) expect(entry.bytes).toBe(finals.get(entry.path));
  });

  it("rejects duplicate publication without overwriting the original", () => {
    const job = id(), generation = id();
    const dispatch = publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    expect(() => publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000)).toThrow();
    claimDispatch(roots, owners, job, generation);
    const receipt = readClaimReceipt(roots, owners, job, generation);
    publishClaimAcknowledgement(roots, owners, job, generation, receipt);
    publishResult(roots, owners, job, generation, '{"schemaVersion":"1.0.0"}');
    expect(() => publishResult(roots, owners, job, generation, '{"schemaVersion":"1.0.0","tampered":true}')).toThrow(/EEXIST/);
    expect(readResult(roots, owners, job, generation)).toBe('{"schemaVersion":"1.0.0"}');
    expect(dispatch.jobId).toBe(job);
  });

  it("keeps cancellation and acknowledgement idempotent while rejecting mismatches", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    claimDispatch(roots, owners, job, generation);
    const receipt = readClaimReceipt(roots, owners, job, generation);
    publishClaimAcknowledgement(roots, owners, job, generation, receipt);
    publishClaimAcknowledgement(roots, owners, job, generation, receipt);
    expect(acknowledgedClaim(roots, owners, job, generation, receipt)).toBe(true);
    expect(() => publishClaimAcknowledgement(roots, owners, job, generation, "0".repeat(64))).toThrow();
    markCancelled(roots, owners, job, generation);
    markCancelled(roots, owners, job, generation);
    expect(isCancelled(roots, owners, job, generation)).toBe(true);
    expect(() => claimDispatch(roots, owners, job, generation)).toThrow();
    expect(() => publishResult(roots, owners, job, generation, '{"schemaVersion":"1.0.0"}')).toThrow();
    expect(() => publishWorkerHeartbeat(roots, owners, job, generation)).toThrow();
  });

  it("absorbs a transient hard-link state and rejects one that never settles", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    claimDispatch(roots, owners, job, generation);
    const receipt = readClaimReceipt(roots, owners, job, generation);
    publishClaimAcknowledgement(roots, owners, job, generation, receipt);
    publishResult(roots, owners, job, generation, '{"schemaVersion":"1.0.0"}');
    const result = path.join(roots.outbox, `${job}.${generation}.json`);
    nlinkInjections.set(result, 50);
    expect(readResult(roots, owners, job, generation)).toBe('{"schemaVersion":"1.0.0"}');
    expect(nlinkInjections.get(result)).toBe(0);
    nlinkInjections.set(result, READ_SAFE_NLINK_RETRIES * 2);
    expect(() => readResult(roots, owners, job, generation)).toThrow(/Unsafe spool file/);
    nlinkInjections.delete(result);
    expect(readResult(roots, owners, job, generation)).toBe('{"schemaVersion":"1.0.0"}');
  });

  it("rejects a persistent unsafe hard link without accepting its bytes", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    claimDispatch(roots, owners, job, generation);
    const receipt = readClaimReceipt(roots, owners, job, generation);
    publishClaimAcknowledgement(roots, owners, job, generation, receipt);
    publishResult(roots, owners, job, generation, '{"schemaVersion":"1.0.0"}');
    const result = path.join(roots.outbox, `${job}.${generation}.json`), planted = path.join(root, "planted.json");
    linkSync(result, planted);
    expect(() => readResult(roots, owners, job, generation)).toThrow(/Unsafe spool file/);
    rmSync(planted);
    expect(readResult(roots, owners, job, generation)).toBe('{"schemaVersion":"1.0.0"}');
  });

  it("publishes and reads heartbeats until cancellation", () => {
    const job = id(), generation = id();
    publishSnapshot(roots, owners, job, generation, source(), Date.now() + 60_000);
    claimDispatch(roots, owners, job, generation);
    const first = Date.now();
    publishWorkerHeartbeat(roots, owners, job, generation, first);
    expect(readWorkerHeartbeat(roots, owners, job, generation)).toBe(first);
    publishWorkerHeartbeat(roots, owners, job, generation, first + 1_000);
    expect(readWorkerHeartbeat(roots, owners, job, generation)).toBe(first + 1_000);
    markCancelled(roots, owners, job, generation);
    expect(() => readWorkerHeartbeat(roots, owners, job, generation)).toThrow();
  });
});
