import { runWorkerJob, assertWorkerEnvironment, type WorkerConfig } from "../src/lib/github-ingestion/scanner-worker";
import { validId } from "../src/lib/github-ingestion/spool";
import path from "node:path";

function integer(name: string): number {
  const value = process.env[name];
  if (!value || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Scanner worker identity configuration is invalid.");
  return Number(value);
}

async function main() {
  assertWorkerEnvironment();
  if (process.argv.length !== 4) throw new Error("Scanner worker requires a job ID and generation.");
  const jobId = validId(process.argv[2]), generation = validId(process.argv[3]);
  const spoolRoot = process.env.CODEARCH_SPOOL_ROOT, scanRoot = process.env.CODEARCH_WORKER_SCAN_ROOT;
  if (!spoolRoot || !path.isAbsolute(spoolRoot) || !scanRoot) throw new Error("Scanner worker roots are not configured.");
  const config: WorkerConfig = {
    roots: { inbox: path.join(spoolRoot, "inbox"), snapshots: path.join(spoolRoot, "snapshots"), claims: path.join(spoolRoot, "claims"), outbox: path.join(spoolRoot, "outbox") },
    owners: { webUid: integer("CODEARCH_WEB_UID"), workerUid: integer("CODEARCH_WORKER_UID"), workerGid: integer("CODEARCH_WORKER_GID"), inboxGid: integer("CODEARCH_INBOX_GID"), outboxGid: integer("CODEARCH_OUTBOX_GID") },
    scanRoot,
  };
  if (config.owners.webUid === config.owners.workerUid || config.owners.workerUid <= 0 || typeof process.getuid !== "function" || process.getuid() !== config.owners.workerUid) throw new Error("Scanner worker Unix identity is invalid.");
  process.umask(0o022); // Scanner bind mounts require non-root container read/traverse; spool files remain 0640.
  await runWorkerJob(config, jobId, generation);
}

main().catch(() => { process.exitCode = 1; });
