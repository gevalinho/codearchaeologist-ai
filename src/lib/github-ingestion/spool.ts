import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safePath, MAX_ARTIFACT_BYTES } from "../architecture/graph";
import { allowedSource, DEFAULT_SCAN_LIMITS } from "../archaeology/selection";

const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MANIFEST_LIMIT = 128 * 1024;
const DISPATCH_LIMIT = 1024;
const RESULT_LIMIT = MAX_ARTIFACT_BYTES + 1024;
type FileRecord = { path: string; bytes: number; sha256: string };
export type SnapshotManifest = { version: 1; jobId: string; generation: string; files: FileRecord[]; totalBytes: number };
export type Dispatch = { version: 1; jobId: string; generation: string; manifestSha256: string; deadline: number };
export type SpoolRoots = { inbox: string; snapshots: string; claims: string; outbox: string };
export type SpoolOwners = { webUid: number; workerUid: number; workerGid: number; inboxGid: number; outboxGid: number };

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const name = (jobId: string, generation: string) => `${validId(jobId)}.${validId(generation)}`;
export function validId(value: unknown): string { if (typeof value !== "string" || !ID.test(value)) throw new Error("Invalid spool identifier."); return value; }

function directory(file: string, uid: number, gid: number, shared = true): void {
  if (!path.isAbsolute(file) || file === "/" || file.includes("\0")) throw new Error("Invalid spool root.");
  const info = lstatSync(file);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(file) !== file || info.uid !== uid || info.gid !== gid || info.mode & (shared ? 0o027 : 0o077) || (info.mode & (shared ? 0o750 : 0o700)) !== (shared ? 0o750 : 0o700)) throw new Error("Unsafe spool directory permissions.");
}
export function validateSpoolRoots(roots: SpoolRoots, owners: SpoolOwners): void {
  const values = Object.values(roots);
  if (new Set(values).size !== values.length) throw new Error("Spool roots must be distinct.");
  directory(roots.inbox, owners.webUid, owners.inboxGid);
  directory(roots.snapshots, owners.webUid, owners.inboxGid);
  directory(roots.claims, owners.workerUid, owners.workerGid, false);
  directory(roots.outbox, owners.workerUid, owners.outboxGid);
}
function actor(uid: number): void { if (typeof process.getuid !== "function" || process.getuid() !== uid) throw new Error("Spool writer identity mismatch."); }
function fsyncDirectory(dir: string): void { const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function writeNew(file: string, bytes: Buffer, mode: number): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function publishFile(dir: string, target: string, bytes: Buffer, mode: number): void {
  const temporary = path.join(dir, `.${randomUUID()}.tmp`);
  try { writeNew(temporary, bytes, mode); linkSync(temporary, target); fsyncDirectory(dir); }
  finally { rmSync(temporary, { force: true }); fsyncDirectory(dir); }
}
function readSafe(file: string, maxBytes: number, uid: number, gid: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== uid || info.gid !== gid || info.mode & 0o027 || info.size < 1 || info.size > maxBytes) throw new Error("Unsafe spool file.");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function parseJson(bytes: Buffer): unknown { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Malformed spool record."); } }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string): boolean { return Object.keys(value).sort().join() === keys; }
function parseManifest(bytes: Buffer, jobId: string, generation: string): SnapshotManifest {
  const value = parseJson(bytes);
  if (!record(value) || !exact(value, "files,generation,jobId,totalBytes,version") || value.version !== 1 || value.jobId !== jobId || value.generation !== generation || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > DEFAULT_SCAN_LIMITS.maxFiles || !Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) > DEFAULT_SCAN_LIMITS.maxTotalBytes) throw new Error("Invalid snapshot manifest.");
  const paths = new Set<string>(); let sum = 0;
  for (const item of value.files) {
    if (!record(item) || !exact(item, "bytes,path,sha256") || !safePath(item.path) || !allowedSource(item.path) || paths.has(item.path) || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 1 || (item.bytes as number) > DEFAULT_SCAN_LIMITS.maxFileBytes || typeof item.sha256 !== "string" || !HASH.test(item.sha256)) throw new Error("Invalid snapshot file record.");
    paths.add(item.path); sum += item.bytes as number;
  }
  if (sum !== value.totalBytes) throw new Error("Snapshot byte count mismatch.");
  return value as SnapshotManifest;
}
function verifyTree(root: string, manifest: SnapshotManifest, owners: SpoolOwners): void {
  const expected = new Set(manifest.files.map(file => file.path));
  const found = new Set<string>();
  const walk = (directoryPath: string, prefix: string) => {
    for (const entry of readdirSync(directoryPath)) {
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (relative === "manifest.json") continue;
      const target = path.join(directoryPath, entry), info = lstatSync(target);
      if (info.isSymbolicLink()) throw new Error("Snapshot contains a symlink.");
      if (info.isDirectory()) { directory(target, owners.webUid, owners.inboxGid); walk(target, relative); }
      else if (info.isFile() && expected.has(relative)) found.add(relative);
      else throw new Error("Snapshot contains an unexpected entry.");
    }
  };
  walk(root, "");
  if (found.size !== expected.size) throw new Error("Snapshot is incomplete.");
}
function snapshotPath(roots: SpoolRoots, jobId: string, generation: string): string { return path.join(roots.snapshots, name(jobId, generation)); }
function dispatchPath(roots: SpoolRoots, jobId: string, generation: string): string { return path.join(roots.inbox, `${name(jobId, generation)}.json`); }
function activePath(roots: SpoolRoots, jobId: string): string { return path.join(roots.inbox, `${validId(jobId)}.active`); }
function cancelledPath(roots: SpoolRoots, jobId: string, generation: string): string { return path.join(roots.inbox, `${name(jobId, generation)}.cancel`); }
function claimPath(roots: SpoolRoots, jobId: string, generation: string): string { return path.join(roots.claims, name(jobId, generation)); }
function resultPath(roots: SpoolRoots, jobId: string, generation: string): string { return path.join(roots.outbox, `${name(jobId, generation)}.json`); }
function receiptPath(roots: SpoolRoots, jobId: string, generation: string): string { return path.join(roots.outbox, `${name(jobId, generation)}.claim`); }
function acknowledgementPath(roots: SpoolRoots, jobId: string, generation: string): string { return path.join(roots.inbox, `${name(jobId, generation)}.ack`); }

function current(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string): boolean {
  try { return readSafe(activePath(roots, jobId), 64, owners.webUid, owners.inboxGid).toString("ascii") === generation; } catch { return false; }
}
function cancelled(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string): boolean {
  try { return readSafe(cancelledPath(roots, jobId, generation), 64, owners.webUid, owners.inboxGid).toString("ascii") === generation; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export function isCancelled(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string): boolean {
  validateSpoolRoots(roots, owners); return !current(roots, owners, jobId, generation) || cancelled(roots, owners, jobId, generation);
}

/** Web side: publish immutable selected bytes, then dispatch. No tokens or database data enter the manifest. */
export function publishSnapshot(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string, files: readonly { path: string; bytes: Buffer }[], deadline: number): Dispatch {
  validateSpoolRoots(roots, owners); actor(owners.webUid); name(jobId, generation);
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 5 * 60_000 || files.length < 1 || files.length > DEFAULT_SCAN_LIMITS.maxFiles) throw new Error("Invalid spool deadline or file count.");
  const entries: FileRecord[] = []; const seen = new Set<string>(); let totalBytes = 0;
  for (const file of files) {
    if (!safePath(file.path) || file.path === "manifest.json" || !allowedSource(file.path) || seen.has(file.path) || !Buffer.isBuffer(file.bytes) || file.bytes.length < 1 || file.bytes.length > DEFAULT_SCAN_LIMITS.maxFileBytes) throw new Error("Invalid source snapshot file.");
    seen.add(file.path); totalBytes += file.bytes.length;
    if (totalBytes > DEFAULT_SCAN_LIMITS.maxTotalBytes) throw new Error("Source snapshot exceeds byte limit.");
    entries.push({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: SnapshotManifest = { version: 1, jobId, generation, files: entries, totalBytes };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length > MANIFEST_LIMIT) throw new Error("Snapshot manifest exceeds limit.");
  const target = snapshotPath(roots, jobId, generation), temporary = path.join(roots.snapshots, `.${name(jobId, generation)}.${randomUUID()}.tmp`);
  if (statExists(target)) throw new Error("Snapshot generation already exists.");
  mkdirSync(temporary, { mode: 0o750 });
  try {
    for (const file of files) {
      const parts = file.path.split("/"); let parent = temporary;
      for (const part of parts.slice(0, -1)) { parent = path.join(parent, part); if (!statExists(parent)) mkdirSync(parent, { mode: 0o750 }); }
      writeNew(path.join(temporary, file.path), file.bytes, 0o640);
    }
    writeNew(path.join(temporary, "manifest.json"), manifestBytes, 0o640);
    fsyncDirectory(temporary); renameSync(temporary, target); fsyncDirectory(roots.snapshots);
    const dispatch: Dispatch = { version: 1, jobId, generation, manifestSha256: digest(manifestBytes), deadline };
    publishFile(roots.inbox, dispatchPath(roots, jobId, generation), Buffer.from(JSON.stringify(dispatch)), 0o640);
    // Active generation is replaced only by the web owner; a stale dispatch cannot be claimed.
    const activeTemporary = path.join(roots.inbox, `.${randomUUID()}.active`);
    try { writeNew(activeTemporary, Buffer.from(generation), 0o640); renameSync(activeTemporary, activePath(roots, jobId)); fsyncDirectory(roots.inbox); }
    finally { rmSync(activeTemporary, { force: true }); }
    return dispatch;
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}
function statExists(file: string): boolean { try { lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }

/** Worker side: verify the dispatch and every source byte before claiming it. */
export function claimDispatch(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string, now = Date.now()): { dispatch: Dispatch; manifest: SnapshotManifest; snapshot: string } {
  validateSpoolRoots(roots, owners); actor(owners.workerUid); name(jobId, generation);
  const bytes = readSafe(dispatchPath(roots, jobId, generation), DISPATCH_LIMIT, owners.webUid, owners.inboxGid), value = parseJson(bytes);
  if (!record(value) || !exact(value, "deadline,generation,jobId,manifestSha256,version") || value.version !== 1 || value.jobId !== jobId || value.generation !== generation || typeof value.manifestSha256 !== "string" || !HASH.test(value.manifestSha256) || !Number.isSafeInteger(value.deadline) || (value.deadline as number) <= now || (value.deadline as number) > now + 5 * 60_000 || isCancelled(roots, owners, jobId, generation)) throw new Error("Invalid, stale, or cancelled dispatch.");
  const snapshot = snapshotPath(roots, jobId, generation);
  directory(snapshot, owners.webUid, owners.inboxGid);
  const manifestBytes = readSafe(path.join(snapshot, "manifest.json"), MANIFEST_LIMIT, owners.webUid, owners.inboxGid);
  if (digest(manifestBytes) !== value.manifestSha256) throw new Error("Snapshot manifest integrity failed.");
  const manifest = parseManifest(manifestBytes, jobId, generation);
  verifyTree(snapshot, manifest, owners);
  for (const file of manifest.files) {
    const parts = file.path.split("/"); let parent = snapshot;
    for (const part of parts.slice(0, -1)) { parent = path.join(parent, part); directory(parent, owners.webUid, owners.inboxGid); }
    const bytes = readSafe(path.join(snapshot, file.path), DEFAULT_SCAN_LIMITS.maxFileBytes, owners.webUid, owners.inboxGid);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error("Source snapshot integrity failed.");
  }
  mkdirSync(claimPath(roots, jobId, generation), { mode: 0o700 }); // EEXIST prevents duplicate processing.
  fsyncDirectory(roots.claims);
  if (isCancelled(roots, owners, jobId, generation)) throw new Error("Dispatch cancelled during claim.");
  publishFile(roots.outbox, receiptPath(roots, jobId, generation), Buffer.from(JSON.stringify({ version: 1, jobId, generation, manifestSha256: value.manifestSha256 })), 0o640);
  return { dispatch: value as Dispatch, manifest, snapshot };
}

/** Web reads the worker-owned receipt without access to worker-private claim state. */
export function readClaimReceipt(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string): string {
  validateSpoolRoots(roots, owners); actor(owners.webUid); name(jobId, generation);
  if (isCancelled(roots, owners, jobId, generation)) throw new Error("Claim is stale or cancelled.");
  const value = parseJson(readSafe(receiptPath(roots, jobId, generation), DISPATCH_LIMIT, owners.workerUid, owners.outboxGid));
  if (!record(value) || !exact(value, "generation,jobId,manifestSha256,version") || value.version !== 1 || value.jobId !== jobId || value.generation !== generation || typeof value.manifestSha256 !== "string" || !HASH.test(value.manifestSha256)) throw new Error("Invalid claim receipt.");
  const dispatch = parseJson(readSafe(dispatchPath(roots, jobId, generation), DISPATCH_LIMIT, owners.webUid, owners.inboxGid));
  if (!record(dispatch) || dispatch.manifestSha256 !== value.manifestSha256) throw new Error("Claim manifest identity mismatch.");
  return value.manifestSha256;
}

/** Call only after the web-owned SQLite compare-and-swap has acknowledged this exact generation. */
export function publishClaimAcknowledgement(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string, manifestSha256: string): void {
  validateSpoolRoots(roots, owners); actor(owners.webUid); name(jobId, generation);
  if (!HASH.test(manifestSha256) || readClaimReceipt(roots, owners, jobId, generation) !== manifestSha256) throw new Error("Claim acknowledgement mismatch.");
  publishFile(roots.inbox, acknowledgementPath(roots, jobId, generation), Buffer.from(JSON.stringify({ version: 1, jobId, generation, manifestSha256 })), 0o640);
}

/** Worker must verify this web-owned acknowledgement immediately before Docker execution. */
export function acknowledgedClaim(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string, manifestSha256: string): boolean {
  validateSpoolRoots(roots, owners); actor(owners.workerUid); name(jobId, generation);
  if (isCancelled(roots, owners, jobId, generation)) return false;
  let bytes: Buffer;
  try { bytes = readSafe(acknowledgementPath(roots, jobId, generation), DISPATCH_LIMIT, owners.webUid, owners.inboxGid); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const value = parseJson(bytes);
  if (!record(value) || !exact(value, "generation,jobId,manifestSha256,version") || value.version !== 1 || value.jobId !== jobId || value.generation !== generation || value.manifestSha256 !== manifestSha256) throw new Error("Invalid claim acknowledgement.");
  return true;
}

export function markCancelled(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string): void {
  validateSpoolRoots(roots, owners); actor(owners.webUid); name(jobId, generation);
  const marker = cancelledPath(roots, jobId, generation);
  if (statExists(marker)) { if (!cancelled(roots, owners, jobId, generation)) throw new Error("Invalid cancellation marker."); return; }
  publishFile(roots.inbox, marker, Buffer.from(generation), 0o640);
}

/** Worker publishes untrusted scanner output; the web side must parseGraph before artifact publication. */
export function publishResult(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string, graphJson: string): void {
  validateSpoolRoots(roots, owners); actor(owners.workerUid); name(jobId, generation);
  directory(claimPath(roots, jobId, generation), owners.workerUid, owners.workerGid, false);
  if (isCancelled(roots, owners, jobId, generation)) throw new Error("Result is stale or cancelled.");
  const dispatch = parseJson(readSafe(dispatchPath(roots, jobId, generation), DISPATCH_LIMIT, owners.webUid, owners.inboxGid));
  if (!record(dispatch) || typeof dispatch.manifestSha256 !== "string" || !acknowledgedClaim(roots, owners, jobId, generation, dispatch.manifestSha256)) throw new Error("Claim is not acknowledged.");
  const body = Buffer.from(graphJson, "utf8");
  if (!body.length || body.length > MAX_ARTIFACT_BYTES) throw new Error("Scanner result exceeds limit.");
  const envelope = Buffer.from(JSON.stringify({ version: 1, jobId, generation, sha256: digest(body), graphJson }));
  if (envelope.length > RESULT_LIMIT) throw new Error("Scanner result envelope exceeds limit.");
  publishFile(roots.outbox, resultPath(roots, jobId, generation), envelope, 0o640);
}
export function readResult(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string): string {
  validateSpoolRoots(roots, owners); actor(owners.webUid); name(jobId, generation);
  if (isCancelled(roots, owners, jobId, generation)) throw new Error("Result is stale or cancelled.");
  directory(claimPath(roots, jobId, generation), owners.workerUid, owners.workerGid, false);
  const value = parseJson(readSafe(resultPath(roots, jobId, generation), RESULT_LIMIT, owners.workerUid, owners.outboxGid));
  if (!record(value) || !exact(value, "generation,graphJson,jobId,sha256,version") || value.version !== 1 || value.jobId !== jobId || value.generation !== generation || typeof value.graphJson !== "string" || typeof value.sha256 !== "string" || !HASH.test(value.sha256)) throw new Error("Invalid scanner result.");
  const body = Buffer.from(value.graphJson, "utf8");
  if (!body.length || body.length > MAX_ARTIFACT_BYTES || digest(body) !== value.sha256) throw new Error("Scanner result integrity failed.");
  return value.graphJson;
}

/** Web cleanup only; callers must first establish terminal SQLite state and an expired worker claim. */
export function cleanupWebSpool(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string): void {
  validateSpoolRoots(roots, owners); actor(owners.webUid); name(jobId, generation);
  for (const file of [dispatchPath(roots, jobId, generation), cancelledPath(roots, jobId, generation), acknowledgementPath(roots, jobId, generation)]) if (statExists(file)) unlinkSync(file);
  const active = activePath(roots, jobId); if (current(roots, owners, jobId, generation)) unlinkSync(active);
  const snapshot = snapshotPath(roots, jobId, generation);
  if (statExists(snapshot)) { directory(snapshot, owners.webUid, owners.inboxGid); rmSync(snapshot, { recursive: true, force: false }); }
  fsyncDirectory(roots.inbox); fsyncDirectory(roots.snapshots);
}

/** Worker cleanup only; never accepts paths from dispatch or result records. */
export function cleanupWorkerSpool(roots: SpoolRoots, owners: SpoolOwners, jobId: string, generation: string): void {
  validateSpoolRoots(roots, owners); actor(owners.workerUid); name(jobId, generation);
  const claim = claimPath(roots, jobId, generation); if (statExists(claim)) { directory(claim, owners.workerUid, owners.workerGid, false); rmSync(claim, { recursive: true, force: false }); }
  const result = resultPath(roots, jobId, generation); if (statExists(result)) { readSafe(result, RESULT_LIMIT, owners.workerUid, owners.outboxGid); unlinkSync(result); }
  const receipt = receiptPath(roots, jobId, generation); if (statExists(receipt)) { readSafe(receipt, DISPATCH_LIMIT, owners.workerUid, owners.outboxGid); unlinkSync(receipt); }
  fsyncDirectory(roots.claims); fsyncDirectory(roots.outbox);
}
