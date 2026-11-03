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
  createDispatchDiagnostics,
  dispatchOnce,
  MIN_LAUNCH_REMAINING_MS,
  workerEnvironment,
  type DispatcherConfig,
  type DispatcherDiagnostics,
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

function captureDiagnostics() {
  const skips: { jobId: string; generation: string; reason: string }[] = [];
  const outcomes: { jobId: string; generation: string; outcome: string }[] = [];
  const diagnostics: DispatcherDiagnostics = {
    noteSkip: (jobId, generation, reason) =>
      skips.push({ jobId, generation, reason }),
    noteWorkerFailure: (jobId, generation, outcome) =>
      outcomes.push({ jobId, generation, outcome }),
    endPass: vi.fn(),
  };
  return { skips, outcomes, diagnostics };
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

  it("records a worker crash without retrying the dispatch", async () => {
    const captured = captureDiagnostics();
    const instance = child();

    const launch = vi.fn(() => {
      queueMicrotask(() => instance.emit("exit", 1));
      return instance;
    });

    expect(
      await dispatchOnce(config, launch, Date.now(), captured.diagnostics),
    ).toBe("failed");
    expect(captured.outcomes).toEqual([
      { jobId: id, generation, outcome: "internal" },
    ]);
    expect(captured.diagnostics.endPass).toHaveBeenCalled();

    // A failed worker must retain its persistent launch marker.
    expect(readdirSync(config.roots.claims)).toContain(
      `${id}.${generation}.launch`,
    );

    // A subsequent dispatcher pass must not relaunch the same job.
    expect(await dispatchOnce(config, launch)).toBe("idle");

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [1, "internal"],
    [2, "cancelled"],
    [3, "snapshot-integrity"],
    [4, "docker-unavailable"],
    [5, "scan-failed"],
    [6, "scan-timeout"],
    [7, "result-rejected"],
    [8, "cleanup-unconfirmed"],
    [99, "internal"],
  ])(
    "maps worker exit code %i to outcome %s without throwing",
    async (code, outcome) => {
      const captured = captureDiagnostics();
      const instance = child();
      const launch = vi.fn(() => {
        queueMicrotask(() => instance.emit("exit", code));
        return instance;
      });
      expect(
        await dispatchOnce(config, launch, Date.now(), captured.diagnostics),
      ).toBe("failed");
      expect(captured.outcomes).toEqual([{ jobId: id, generation, outcome }]);
      expect(readdirSync(config.roots.claims)).toContain(
        `${id}.${generation}.launch`,
      );
    },
  );

  it("records a worker signal without terminating the dispatcher", async () => {
    const captured = captureDiagnostics();
    const instance = child();
    const launch = vi.fn(() => {
      queueMicrotask(() => instance.emit("exit", null, "SIGKILL"));
      return instance;
    });
    expect(
      await dispatchOnce(config, launch, Date.now(), captured.diagnostics),
    ).toBe("failed");
    expect(captured.outcomes).toEqual([
      { jobId: id, generation, outcome: "signal" },
    ]);
    expect(readdirSync(config.roots.claims)).toContain(
      `${id}.${generation}.launch`,
    );
  });

  it("records a supervision timeout without terminating the dispatcher", async () => {
    vi.useFakeTimers();
    try {
      const captured = captureDiagnostics();
      const instance = child();
      const launch = vi.fn(() => instance);
      const pending = dispatchOnce(
        config,
        launch,
        Date.now(),
        captured.diagnostics,
      );
      await vi.advanceTimersByTimeAsync(95_000);
      expect(await pending).toBe("failed");
      expect(instance.kill).toHaveBeenCalledWith("SIGKILL");
      expect(captured.outcomes).toEqual([
        { jobId: id, generation, outcome: "timeout" },
      ]);
      expect(readdirSync(config.roots.claims)).toContain(
        `${id}.${generation}.launch`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["throw", "error-event"])(
    "records a worker launch failure without terminating the dispatcher (%s)",
    async (kind) => {
      const captured = captureDiagnostics();
      const instance = child();
      const launch =
        kind === "throw"
          ? vi.fn<Launch>(() => {
              throw new Error("spawn unavailable");
            })
          : vi.fn<Launch>(() => {
              queueMicrotask(() => instance.emit("error", new Error("lost")));
              return instance;
            });
      expect(
        await dispatchOnce(config, launch, Date.now(), captured.diagnostics),
      ).toBe("failed");
      expect(captured.outcomes).toEqual([
        { jobId: id, generation, outcome: "launch-failed" },
      ]);
      expect(readdirSync(config.roots.claims)).toContain(
        `${id}.${generation}.launch`,
      );
      expect(await dispatchOnce(config, launch)).toBe("idle");
    },
  );

  it("continues dispatching after an unsuccessful job", async () => {
    const failing = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      next = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    writeFileSync(
      path.join(config.roots.inbox, `${next}.${generation}.json`),
      "dispatch",
    );
    const now = Date.now();
    inspect.mockImplementation(
      (_roots: unknown, _owners: unknown, jobId: string) => ({
        deadline: jobId === failing ? now + 10_000 : now + 60_000,
      }),
    );
    const captured = captureDiagnostics();
    const instances = [child(), child()];
    const codes = [5, 0];
    let calls = 0;
    const launch = vi.fn<Launch>(() => {
      const instance = instances[calls];
      const code = codes[calls];
      calls++;
      queueMicrotask(() => instance.emit("exit", code));
      return instance;
    });
    expect(
      await dispatchOnce(config, launch, now, captured.diagnostics),
    ).toBe("failed");
    expect(launch.mock.calls[0][1].slice(-2)).toEqual([failing, generation]);
    expect(await dispatchOnce(config, launch, now, captured.diagnostics)).toBe(
      "launched",
    );
    expect(launch.mock.calls[1][1].slice(-2)).toEqual([next, generation]);
    expect(captured.outcomes).toEqual([
      { jobId: failing, generation, outcome: "scan-failed" },
    ]);
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

  it("reports skip reasons without exposing sensitive content", async () => {
    const captured = captureDiagnostics();
    const diagnostics = captured.diagnostics;
    inspect.mockImplementation(() => {
      throw Object.assign(new Error("Invalid, expired, or cancelled dispatch."), {
        code: "cancelled",
      });
    });
    const launch = vi.fn();
    expect(await dispatchOnce(config, launch, Date.now(), diagnostics)).toBe(
      "idle",
    );
    expect(launch).not.toHaveBeenCalled();
    expect(captured.skips).toEqual([
      { jobId: id, generation, reason: "cancelled" },
    ]);
    expect(diagnostics.endPass).toHaveBeenCalledOnce();
    inspect.mockImplementation(() => {
      throw new Error("Unexpected failure");
    });
    captured.skips.length = 0;
    expect(await dispatchOnce(config, launch, Date.now(), diagnostics)).toBe(
      "idle",
    );
    expect(captured.skips).toEqual([
      { jobId: id, generation, reason: "invalid" },
    ]);
  });

  it("launches the earliest deadline first regardless of inbox order", async () => {
    const early = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab",
      late = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    for (const job of [early, late])
      writeFileSync(
        path.join(config.roots.inbox, `${job}.${generation}.json`),
        "dispatch",
      );
    const now = 1_000_000;
    inspect.mockImplementation(
      (_roots: unknown, _owners: unknown, jobId: string) => ({
        deadline: jobId === early ? now + 10_000 : now + 60_000,
      }),
    );
    const instance = child();
    const launch = vi.fn<Launch>(() => {
      queueMicrotask(() => instance.emit("exit", 0));
      return instance;
    });
    expect(await dispatchOnce(config, launch, now)).toBe("launched");
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][1].slice(-2)).toEqual([early, generation]);
  });

  it("guards launches below the minimum remaining lifetime without marking them", async () => {
    expect(MIN_LAUNCH_REMAINING_MS).toBe(5_000);
    const captured = captureDiagnostics();
    const diagnostics = captured.diagnostics;
    const now = 1_000_000;
    inspect.mockReturnValue({ deadline: now + MIN_LAUNCH_REMAINING_MS - 1 });
    const launch = vi.fn();
    expect(await dispatchOnce(config, launch, now, diagnostics)).toBe("idle");
    expect(launch).not.toHaveBeenCalled();
    expect(readdirSync(config.roots.claims)).not.toContain(
      `${id}.${generation}.launch`,
    );
    expect(captured.skips).toEqual([
      { jobId: id, generation, reason: "insufficient-time" },
    ]);
    inspect.mockReturnValue({ deadline: now + MIN_LAUNCH_REMAINING_MS });
    const instance = child();
    const launching = vi.fn(() => {
      queueMicrotask(() => instance.emit("exit", 0));
      return instance;
    });
    expect(await dispatchOnce(config, launching, now, diagnostics)).toBe(
      "launched",
    );
    expect(launching).toHaveBeenCalledOnce();
  });

  it("skips a doomed dispatch and launches a viable later deadline", async () => {
    const doomed = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      viable = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    for (const job of [doomed, viable])
      writeFileSync(
        path.join(config.roots.inbox, `${job}.${generation}.json`),
        "dispatch",
      );
    const now = 1_000_000;
    inspect.mockImplementation(
      (_roots: unknown, _owners: unknown, jobId: string) => ({
        deadline: jobId === doomed ? now + 1_000 : now + 60_000,
      }),
    );
    const captured = captureDiagnostics();
    const diagnostics = captured.diagnostics;
    const instance = child();
    const launch = vi.fn<Launch>(() => {
      queueMicrotask(() => instance.emit("exit", 0));
      return instance;
    });
    expect(await dispatchOnce(config, launch, now, diagnostics)).toBe(
      "launched",
    );
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][1].slice(-2)).toEqual([viable, generation]);
    expect(captured.skips).toEqual([
      { jobId: doomed, generation, reason: "insufficient-time" },
    ]);
    expect(readdirSync(config.roots.claims)).not.toContain(
      `${doomed}.${generation}.launch`,
    );
  });
});

describe("dispatcher skip reporter", () => {
  it("rate-limits detail lines and emits accumulated summaries with safe content only", () => {
    const lines: string[] = [];
    let now = 1_000_000;
    const diagnostics = createDispatchDiagnostics(
      (line) => lines.push(line),
      () => now,
    );
    for (let i = 0; i < 7; i++)
      diagnostics.noteSkip(
        `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa${i}`,
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        i % 2 ? "cancelled" : "expired",
      );
    diagnostics.endPass();
    const details = lines.filter((line) => line.includes("skip jobId="));
    expect(details).toHaveLength(5);
    expect(lines).toContain(
      "scanner-dispatcher: pass skipped=7 worker_failed=0 cancelled=3 expired=4\n",
    );
    diagnostics.endPass();
    expect(lines.filter((line) => line.includes("pass skipped="))).toHaveLength(
      1,
    );
    now += 10_000;
    diagnostics.noteSkip(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "invalid",
    );
    diagnostics.endPass();
    expect(lines.filter((line) => line.includes("pass skipped="))).toHaveLength(
      1,
    );
    now += 30_000;
    diagnostics.endPass();
    expect(lines).toContain(
      "scanner-dispatcher: pass skipped=1 worker_failed=0 invalid=1\n",
    );
    const allowed =
      /^scanner-dispatcher: (skip jobId=[0-9a-f-]{36} generation=[0-9a-f-]{36} reason=[a-z-]+|worker jobId=[0-9a-f-]{36} generation=[0-9a-f-]{36} outcome=[a-z-]+|pass skipped=\d+ worker_failed=\d+( (worker_)?[a-z-]+=\d+)*)\n$/;
    for (const line of lines) expect(line).toMatch(allowed);
  });

  it("reports worker outcomes with safe content under the shared rate limit", () => {
    const lines: string[] = [];
    const now = 1_000_000;
    const diagnostics = createDispatchDiagnostics(
      (line) => lines.push(line),
      () => now,
    );
    diagnostics.noteSkip(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "expired",
    );
    diagnostics.noteWorkerFailure(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "scan-timeout",
    );
    diagnostics.noteWorkerFailure(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "signal",
    );
    diagnostics.endPass();
    expect(lines).toContain(
      "scanner-dispatcher: worker jobId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa generation=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb outcome=scan-timeout\n",
    );
    expect(lines).toContain(
      "scanner-dispatcher: pass skipped=1 worker_failed=2 expired=1 worker_scan-timeout=1 worker_signal=1\n",
    );
    for (let i = 0; i < 5; i++)
      diagnostics.noteWorkerFailure(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "internal",
      );
    expect(
      lines.filter((line) => line.includes("outcome=")),
    ).toHaveLength(4);
    const allowed =
      /^scanner-dispatcher: (skip jobId=[0-9a-f-]{36} generation=[0-9a-f-]{36} reason=[a-z-]+|worker jobId=[0-9a-f-]{36} generation=[0-9a-f-]{36} outcome=[a-z-]+|pass skipped=\d+ worker_failed=\d+( (worker_)?[a-z-]+=\d+)*)\n$/;
    for (const line of lines) expect(line).toMatch(allowed);
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
