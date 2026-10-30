import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import {
  inspectPendingDispatch,
  validId,
  validateSpoolRoots,
  type SpoolOwners,
  type SpoolRoots,
} from "./spool";

export type DispatcherConfig = {
  roots: SpoolRoots;
  owners: SpoolOwners;
  spoolRoot: string;
  scanRoot: string;
  appRoot: string;
  node: string;
};
export type Launch = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "ignore" },
) => ChildProcess;
const marker =
  /^([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\.([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\.json$/;

function canonicalDirectory(value: string): void {
  if (
    !path.isAbsolute(value) ||
    value === "/" ||
    value.includes("\0") ||
    path.normalize(value) !== value ||
    realpathSync(value) !== value ||
    !lstatSync(value).isDirectory()
  )
    throw new Error("Invalid dispatcher directory.");
}

export function workerEnvironment(config: DispatcherConfig): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    DOCKER_CONFIG: "/nonexistent",
    XDG_RUNTIME_DIR: `/run/user/${config.owners.workerUid}`,
    DOCKER_HOST: `unix:///run/user/${config.owners.workerUid}/docker.sock`,
    CODEARCH_SPOOL_ROOT: config.spoolRoot,
    CODEARCH_WORKER_SCAN_ROOT: config.scanRoot,
    CODEARCH_WEB_UID: String(config.owners.webUid),
    CODEARCH_WORKER_UID: String(config.owners.workerUid),
    CODEARCH_WORKER_GID: String(config.owners.workerGid),
    CODEARCH_INBOX_GID: String(config.owners.inboxGid),
    CODEARCH_OUTBOX_GID: String(config.owners.outboxGid),
  };
}

export function validateDispatcherConfig(config: DispatcherConfig): void {
  if (
    typeof process.getuid !== "function" ||
    process.getuid() !== config.owners.workerUid ||
    config.owners.webUid === config.owners.workerUid ||
    config.owners.workerUid <= 0
  )
    throw new Error("Dispatcher must run under the worker identity.");
  canonicalDirectory(config.spoolRoot);
  canonicalDirectory(config.scanRoot);
  canonicalDirectory(config.appRoot);
  const application = lstatSync(config.appRoot);
  if (application.mode & 0o022)
    throw new Error(
      "Worker application root is writable by a shared identity.",
    );
  try {
    lstatSync(path.join(config.appRoot, ".env.local"));
    throw new Error("Worker application root contains a web environment file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    config.roots.inbox !== path.join(config.spoolRoot, "inbox") ||
    config.roots.snapshots !== path.join(config.spoolRoot, "snapshots") ||
    config.roots.claims !== path.join(config.spoolRoot, "claims") ||
    config.roots.outbox !== path.join(config.spoolRoot, "outbox")
  )
    throw new Error("Dispatcher spool roots mismatch.");
  const scan = lstatSync(config.scanRoot);
  if (scan.uid !== config.owners.workerUid || scan.mode & 0o077)
    throw new Error("Worker scan root is not private.");
  if (
    !path.isAbsolute(config.node) ||
    realpathSync(config.node) !== config.node
  )
    throw new Error("Dispatcher Node executable is invalid.");
  validateSpoolRoots(config.roots, config.owners);
}

/** One launch at a time. Persistent per-dispatch markers prevent retry after an ambiguous crash. */
export async function dispatchOnce(
  config: DispatcherConfig,
  launch: Launch = spawn,
  now = Date.now(),
): Promise<"idle" | "launched"> {
  validateDispatcherConfig(config);
  const lock = path.join(config.roots.claims, ".dispatcher-active");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "idle";
    throw error;
  }
  try {
    const names = readdirSync(config.roots.inbox);
    if (names.length > 1_000)
      throw new Error("Dispatcher inbox exceeds entry limit.");
    for (const filename of names.sort()) {
      const match = marker.exec(filename);
      if (!match) continue;
      const jobId = validId(match[1]),
        generation = validId(match[2]);
      const launchMarker = path.join(
        config.roots.claims,
        `${jobId}.${generation}.launch`,
      );
      if (
        readdirSync(config.roots.claims).includes(`${jobId}.${generation}`) ||
        readdirSync(config.roots.claims).includes(
          `${jobId}.${generation}.launch`,
        )
      )
        continue;
      try {
        inspectPendingDispatch(
          config.roots,
          config.owners,
          jobId,
          generation,
          now,
        );
      } catch {
        continue;
      }
      try {
        mkdirSync(launchMarker, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const args = [
        "--experimental-transform-types",
        "--import",
        path.join(config.appRoot, "scripts/register-types.mjs"),
        path.join(config.appRoot, "scripts/scanner-worker.ts"),
        jobId,
        generation,
      ];
      let child: ChildProcess;

      try {
        child = launch(config.node, args, {
          cwd: config.appRoot,
          env: workerEnvironment(config),
          stdio: "ignore",
        });
      } catch {
        throw new Error("Scanner worker could not be launched.");
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timedOut = false;

        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (error) reject(error);
          else resolve();
        };

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
          finish(new Error("Scanner worker exceeded its execution deadline."));
        }, 95_000);

        child.once("error", () => {
          finish(new Error("Scanner worker process failed to start."));
        });

        child.once("exit", (code, signal) => {
          if (timedOut) {
            finish(
              new Error("Scanner worker exceeded its execution deadline."),
            );
          } else if (signal) {
            finish(new Error("Scanner worker terminated unexpectedly."));
          } else if (code !== 0) {
            finish(new Error("Scanner worker exited unsuccessfully."));
          } else {
            finish();
          }
        });
      });
      return "launched";
    }
    return "idle";
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
