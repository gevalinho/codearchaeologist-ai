import "server-only";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { validateSpoolRoots, type SpoolOwners, type SpoolRoots } from "./spool";
import { privateDirectory } from "./state-db";
import type { WorkerHandoff } from "./jobs";

function integer(environment: NodeJS.ProcessEnv, key: string): number {
  const value = environment[key];
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error("Scanner handoff identity configuration is invalid.");
  return Number(value);
}

function canonicalDirectory(value: string | undefined): string {
  if (!value || !path.isAbsolute(value) || value === "/" || value.includes("\0") || path.normalize(value) !== value || realpathSync(value) !== value || !lstatSync(value).isDirectory()) throw new Error("Scanner handoff path is not a canonical directory.");
  return value;
}

export function loadProductionWorkerHandoff(environment: NodeJS.ProcessEnv = process.env): WorkerHandoff {
  if (environment.NODE_ENV !== "production" || environment.CODEARCH_PRODUCTION_SCANNING !== "1") throw new Error("Production scanner handoff is disabled.");
  const root = canonicalDirectory(environment.CODEARCH_SPOOL_ROOT);
  const owners: SpoolOwners = {
    webUid: integer(environment, "CODEARCH_WEB_UID"), workerUid: integer(environment, "CODEARCH_WORKER_UID"),
    workerGid: integer(environment, "CODEARCH_WORKER_GID"), inboxGid: integer(environment, "CODEARCH_INBOX_GID"), outboxGid: integer(environment, "CODEARCH_OUTBOX_GID"),
  };
  if (owners.webUid === owners.workerUid || typeof process.getuid !== "function" || process.getuid() !== owners.webUid) throw new Error("Scanner handoff web identity mismatch.");
  const roots: SpoolRoots = { inbox: path.join(root, "inbox"), snapshots: path.join(root, "snapshots"), claims: path.join(root, "claims"), outbox: path.join(root, "outbox") };
  validateSpoolRoots(roots, owners);
  const privatePaths = [environment.CODEARCH_DB_PATH, environment.CODEARCH_ARTIFACT_DIR, environment.CODEARCH_STAGING_DIR];
  if (privatePaths.some(value => !value || !path.isAbsolute(value) || value === root || value.startsWith(`${root}${path.sep}`))) throw new Error("Web private state must be outside the worker spool.");
  privateDirectory(path.dirname(environment.CODEARCH_DB_PATH!));
  privateDirectory(environment.CODEARCH_ARTIFACT_DIR!);
  privateDirectory(environment.CODEARCH_STAGING_DIR!);
  try {
    const database = lstatSync(environment.CODEARCH_DB_PATH!);
    if (!database.isFile() || database.nlink !== 1 || database.uid !== owners.webUid || database.mode & 0o077) throw new Error("Web database is not private.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { roots, owners };
}
