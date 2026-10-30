import "server-only";
import { DatabaseSync } from "node:sqlite";
import { openStateDatabase } from "./state-db";
import { validId } from "./spool";
import type { acquirePublicRepository } from "./acquire";

const HASH = /^[a-f0-9]{64}$/;
const validHash = (hash: string) => { if (!HASH.test(hash)) throw new Error("Invalid dispatch hash."); return hash; };
export type AcquiredSource = Awaited<ReturnType<typeof acquirePublicRepository>>;
export type DispatchState = { jobId: string; generation: string; manifestSha256: string; deadline: number; acknowledgedAt?: number; heartbeatAt?: number; resultSha256?: string; source?: AcquiredSource; quotaLeaseId?: string; cancelled: boolean };
function validSource(value: unknown): value is AcquiredSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  const integer = (name: string, max: number) => Number.isSafeInteger(source[name]) && (source[name] as number) >= 0 && (source[name] as number) <= max;
  return integer("sourceFiles", 300) && (source.sourceFiles as number) > 0 && integer("eligibleFiles", 100_000) && integer("omittedFiles", 100_000) && (source.eligibleFiles as number) === (source.sourceFiles as number) + (source.omittedFiles as number) && integer("sourceBytes", 12 * 1024 * 1024) && integer("skippedFiles", 100_000) && integer("treeEntries", 100_000) && typeof source.commitSha === "string" && /^[a-f0-9]{40}$/.test(source.commitSha) && (source.canonicalOwner === undefined || typeof source.canonicalOwner === "string" && /^[A-Za-z0-9-]{1,39}$/.test(source.canonicalOwner)) && (source.canonicalName === undefined || typeof source.canonicalName === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(source.canonicalName));
}

/** Web-owned SQLite state. The scanner worker never imports or opens this store. */
export class SqliteDispatchStore {
  private readonly db: DatabaseSync;
  constructor(file: string, private readonly now: () => number = Date.now) { this.db = openStateDatabase(file); }
  close(): void { this.db.close(); }

  create(jobId: string, jobLeaseId: string, generation: string, manifestSha256: string, deadline: number, source?: AcquiredSource, quotaLeaseId?: string): boolean {
    validId(jobId); validId(jobLeaseId); validId(generation); validHash(manifestSha256);
    if (quotaLeaseId !== undefined) validId(quotaLeaseId);
    if ((source === undefined) !== (quotaLeaseId === undefined)) throw new Error("Incomplete dispatch state.");
    if (source !== undefined && !validSource(source)) throw new Error("Invalid acquired source metadata.");
    const sourceJson = source === undefined ? null : JSON.stringify(source);
    if (sourceJson && sourceJson.length > 2_000) throw new Error("Dispatch source metadata exceeds limit.");
    const now = this.now();
    if (!Number.isSafeInteger(deadline) || deadline <= now || deadline > now + 90_000) throw new Error("Invalid dispatch deadline.");
    return this.db.prepare(`INSERT INTO scanner_dispatches(job_id,generation,job_lease_id,manifest_sha256,deadline_at,source_json,quota_lease_id)
      SELECT id,?,?,?,?,?,? FROM github_jobs WHERE id=? AND lease_id=? AND phase='scanning-supported-source-files' AND cancelled=0 AND expires_at>?
      ON CONFLICT(job_id) DO NOTHING`).run(generation, jobLeaseId, manifestSha256, deadline, sourceJson, quotaLeaseId ?? null, jobId, jobLeaseId, now).changes === 1;
  }

  acknowledge(jobId: string, generation: string, manifestSha256: string): boolean {
    validId(jobId); validId(generation); validHash(manifestSha256);
    const now = this.now();
    return this.db.prepare(`UPDATE scanner_dispatches SET claim_ack_at=?, heartbeat_at=? WHERE job_id=? AND generation=? AND manifest_sha256=?
      AND claim_ack_at IS NULL AND cancelled=0 AND deadline_at>?
      AND EXISTS(SELECT 1 FROM github_jobs WHERE id=? AND lease_id=scanner_dispatches.job_lease_id AND phase='scanning-supported-source-files' AND cancelled=0 AND expires_at>?)`)
      .run(now, now, jobId, generation, manifestSha256, now, jobId, now).changes === 1;
  }

  heartbeat(jobId: string, generation: string): boolean {
    validId(jobId); validId(generation); const now = this.now();
    return this.db.prepare(`UPDATE scanner_dispatches SET heartbeat_at=? WHERE job_id=? AND generation=? AND claim_ack_at IS NOT NULL
      AND cancelled=0 AND deadline_at>? AND EXISTS(SELECT 1 FROM github_jobs WHERE id=? AND lease_id=scanner_dispatches.job_lease_id AND cancelled=0 AND expires_at>?)`)
      .run(now, jobId, generation, now, jobId, now).changes === 1;
  }

  recordResult(jobId: string, generation: string, sha256: string): boolean {
    validId(jobId); validId(generation); validHash(sha256); const now = this.now();
    return this.db.prepare(`UPDATE scanner_dispatches SET result_sha256=? WHERE job_id=? AND generation=? AND claim_ack_at IS NOT NULL
      AND result_sha256 IS NULL AND cancelled=0 AND deadline_at>? AND EXISTS(SELECT 1 FROM github_jobs WHERE id=? AND lease_id=scanner_dispatches.job_lease_id AND cancelled=0 AND expires_at>?)`)
      .run(sha256, jobId, generation, now, jobId, now).changes === 1;
  }

  cancel(jobId: string, generation: string): boolean {
    validId(jobId); validId(generation);
    return this.db.prepare("UPDATE scanner_dispatches SET cancelled=1 WHERE job_id=? AND generation=? AND cancelled=0").run(jobId, generation).changes === 1;
  }

  get(jobId: string): DispatchState | undefined {
    validId(jobId);
    const row = this.db.prepare("SELECT generation,manifest_sha256,deadline_at,claim_ack_at,heartbeat_at,result_sha256,source_json,quota_lease_id,cancelled FROM scanner_dispatches WHERE job_id=?").get(jobId) as { generation: string; manifest_sha256: string; deadline_at: number; claim_ack_at: number | null; heartbeat_at: number | null; result_sha256: string | null; source_json: string | null; quota_lease_id: string | null; cancelled: number } | undefined;
    if (!row) return undefined;
    let source: AcquiredSource | undefined;
    try { if (row.source_json) { const parsed: unknown = JSON.parse(row.source_json); if (!validSource(parsed)) return undefined; source = parsed; } } catch { return undefined; }
    return { jobId, generation: row.generation, manifestSha256: row.manifest_sha256, deadline: row.deadline_at, ...(row.claim_ack_at === null ? {} : { acknowledgedAt: row.claim_ack_at }), ...(row.heartbeat_at === null ? {} : { heartbeatAt: row.heartbeat_at }), ...(row.result_sha256 === null ? {} : { resultSha256: row.result_sha256 }), ...(source ? { source } : {}), ...(row.quota_lease_id ? { quotaLeaseId: row.quota_lease_id } : {}), cancelled: row.cancelled === 1 };
  }
}
