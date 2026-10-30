import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

vi.mock("server-only", () => ({}));
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../src/lib/github-ingestion/spool", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/lib/github-ingestion/spool")>();
  return {
    ...original,
    validateSpoolRoots: vi.fn(),
    inspectPendingDispatch: inspect,
  };
});
import {
  dispatchOnce,
  workerEnvironment,
  type DispatcherConfig,
  type Launch,
} from "../src/lib/github-ingestion/scanner-dispatcher";
import { loadProductionWorkerHandoff } from "../src/lib/github-ingestion/production-handoff";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  generation = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
let root: string, config: DispatcherConfig;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-dispatcher-"));
  for (const dir of ["inbox", "snapshots", "claims", "outbox", "scan", "app"])
    mkdirSync(path.join(root, dir), { mode: 0o700 });
  config = {
    spoolRoot: root,
    scanRoot: path.join(root, "scan"),
    appRoot: path.join(root, "app"),
    node: process.execPath,
    roots: {
      inbox: path.join(root, "inbox"),
      snapshots: path.join(root, "snapshots"),
      claims: path.join(root, "claims"),
      outbox: path.join(root, "outbox"),
    },
    owners: {
      webUid: process.getuid!() + 1,
      workerUid: process.getuid!(),
      workerGid: process.getgid!(),
      inboxGid: process.getgid!(),
      outboxGid: process.getgid!(),
    },
  };
  writeFileSync(
    path.join(config.roots.inbox, `${id}.${generation}.json`),
    "dispatch",
  );
  inspect.mockReset();
  inspect.mockReturnValue({ deadline: Date.now() + 30_000 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function child(): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  process.kill = vi.fn(() => true);
  return process;
}

describe("bounded scanner dispatcher", () => {
  it("launches one fixed worker command with only allowlisted environment variables", async () => {
    const instance = child();
    const launch = vi.fn<Launch>(() => {
      queueMicrotask(() => instance.emit("exit", 0));
      return instance;
    });
    expect(await dispatchOnce(config, launch)).toBe("launched");
    expect(launch).toHaveBeenCalledTimes(1);
    const [executable, args, options] = launch.mock.calls[0];
    expect(executable).toBe(process.execPath);
    expect(args.slice(-2)).toEqual([id, generation]);
    expect(args).toContain(
      path.join(config.appRoot, "scripts/scanner-worker.ts"),
    );
    expect(Object.keys(options.env).sort()).toEqual(
      Object.keys(workerEnvironment(config)).sort(),
    );
    for (const secret of [
      "CODEARCH_DB_PATH",
      "GITHUB_APP_PRIVATE_KEY",
      "CODEARCH_TOKEN_ENCRYPTION_KEY",
      "BASETEN_API_KEY",
      "FEATURE_AI_ACCESS_KEY",
    ])
      expect(options.env).not.toHaveProperty(secret);
    expect(readdirSync(config.roots.claims)).toContain(
      `${id}.${generation}.launch`,
    );
    expect(await dispatchOnce(config, launch)).toBe("idle");
  });

  it("prevents a concurrent launch while a worker is active", async () => {
    const instance = child(),
      launch = vi.fn(() => instance);
    const first = dispatchOnce(config, launch);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    expect(await dispatchOnce(config, launch)).toBe("idle");
    instance.emit("exit", 0);
    expect(await first).toBe("launched");
  });

  it.each(["expired", "cancelled"])(
    "does not launch a %s dispatch",
    async () => {
      inspect.mockImplementation(() => {
        throw new Error("Invalid dispatch.");
      });
      const launch = vi.fn();
      expect(await dispatchOnce(config, launch)).toBe("idle");
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("reports a worker crash and does not retry the dispatch", async () => {
    const instance = child();

    const launch = vi.fn(() => {
      queueMicrotask(() => instance.emit("exit", 1));
      return instance;
    });

    await expect(dispatchOnce(config, launch)).rejects.toThrow(
      "Scanner worker exited unsuccessfully.",
    );

    // A failed worker must retain its persistent launch marker.
    expect(readdirSync(config.roots.claims)).toContain(
      `${id}.${generation}.launch`,
    );

    // A subsequent dispatcher pass must not relaunch the same job.
    expect(await dispatchOnce(config, launch)).toBe("idle");

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsafe identity or a web environment file", async () => {
    const launch = vi.fn();
    await expect(
      dispatchOnce(
        {
          ...config,
          owners: { ...config.owners, webUid: config.owners.workerUid },
        },
        launch,
      ),
    ).rejects.toThrow();
    writeFileSync(path.join(config.appRoot, ".env.local"), "private");
    await expect(dispatchOnce(config, launch)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("production handoff gate", () => {
  it("rejects missing gate and incomplete configuration", () => {
    expect(() =>
      loadProductionWorkerHandoff({ NODE_ENV: "production" }),
    ).toThrow();
    expect(() =>
      loadProductionWorkerHandoff({
        NODE_ENV: "production",
        CODEARCH_PRODUCTION_SCANNING: "1",
      }),
    ).toThrow();
  });
});
