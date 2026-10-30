import { dispatchOnce, type DispatcherConfig } from "../src/lib/github-ingestion/scanner-dispatcher";
import { assertWorkerEnvironment } from "../src/lib/github-ingestion/scanner-worker";
import path from "node:path";

function integer(name: string): number {
  const value = process.env[name];
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Dispatcher identity configuration is invalid.");
  return Number(value);
}

async function main() {
  assertWorkerEnvironment();
  if (process.argv.length !== 2) throw new Error("Dispatcher accepts no job arguments.");
  const spoolRoot = process.env.CODEARCH_SPOOL_ROOT, scanRoot = process.env.CODEARCH_WORKER_SCAN_ROOT, appRoot = process.env.CODEARCH_WORKER_APP_ROOT;
  if (!spoolRoot || !scanRoot || !appRoot) throw new Error("Dispatcher roots are unavailable.");
  const config: DispatcherConfig = {
    spoolRoot, scanRoot, appRoot, node: process.execPath,
    roots: { inbox: path.join(spoolRoot, "inbox"), snapshots: path.join(spoolRoot, "snapshots"), claims: path.join(spoolRoot, "claims"), outbox: path.join(spoolRoot, "outbox") },
    owners: { webUid: integer("CODEARCH_WEB_UID"), workerUid: integer("CODEARCH_WORKER_UID"), workerGid: integer("CODEARCH_WORKER_GID"), inboxGid: integer("CODEARCH_INBOX_GID"), outboxGid: integer("CODEARCH_OUTBOX_GID") },
  };
  process.umask(0o027);
  while (true) {
    await dispatchOnce(config);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

main().catch(() => { process.exitCode = 1; });
