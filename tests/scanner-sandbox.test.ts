import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  spawn: spawnMock,
}));

import { execFileSync } from "node:child_process";
import {
  dockerCommand,
  runIsolatedScanner,
  scannerDockerEnvironment,
  stageRunner,
  type DockerCommand,
} from "../src/lib/github-ingestion/sandbox";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  process.env = { ...originalEnv };
});

function mockDockerSuccess() {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };

    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    queueMicrotask(() => child.emit("close", 0));

    return child;
  });
}

describe("scanner Docker CLI environment", () => {
  it("passes only approved Docker settings and excludes credentials", async () => {
    const uid = process.getuid?.();
    expect(uid).toBeDefined();

    vi.stubEnv("NODE_ENV", "test");
    process.env.DOCKER_HOST = `unix:///run/user/${uid}/docker.sock`;
    process.env.GITHUB_TOKEN = "secret-github-token";
    process.env.BASETEN_API_KEY = "secret-baseten-key";

    mockDockerSuccess();

    const result = await dockerCommand(["info"], 1000, 1024);

    expect(result.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledOnce();

    const [executable, args, options] = spawnMock.mock.calls[0];

    expect(executable).toBe("docker");
    expect(args).toEqual(["info"]);
    expect(options.shell).toBe(false);
    expect(options.env.DOCKER_HOST).toBe(`unix:///run/user/${uid}/docker.sock`);
    expect(options.env.DOCKER_CONFIG).toBe("/nonexistent");
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
    expect(options.env.BASETEN_API_KEY).toBeUndefined();
  });

  it("rejects a mismatched production Docker socket", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    process.env.DOCKER_CONFIG = "/nonexistent";
    process.env.XDG_RUNTIME_DIR = `/run/user/${process.getuid?.()}`;

    await expect(dockerCommand(["info"], 1000, 1024)).rejects.toThrow(
      "production worker identity is not verified",
    );

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not launch Docker for an already-aborted operation", async () => {
    vi.stubEnv("NODE_ENV", "test");

    const controller = new AbortController();
    controller.abort();

    const result = await dockerCommand(["info"], 1000, 1024, controller.signal);

    expect(result.failed).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("production rootless Docker configuration", () => {
  const workerUid = 997;
  const runtime = "/run/user/997";
  const host = `unix://${runtime}/docker.sock`;

  const validEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    DOCKER_HOST: host,
    DOCKER_CONFIG: "/nonexistent",
    XDG_RUNTIME_DIR: runtime,
  };

  it("accepts the verified worker's rootless socket", () => {
    const result = scannerDockerEnvironment(validEnv, workerUid);

    expect(result.DOCKER_HOST).toBe(host);
    expect(result.DOCKER_CONFIG).toBe("/nonexistent");
    expect(result.XDG_RUNTIME_DIR).toBe(runtime);
    expect(result.HOME).toBe("/nonexistent");
  });

  it("rejects a missing Docker socket", () => {
    expect(() =>
      scannerDockerEnvironment(
        { ...validEnv, DOCKER_HOST: undefined },
        workerUid,
      ),
    ).toThrow("invalid rootless Docker configuration");
  });

  it("rejects the rootful Docker socket", () => {
    expect(() =>
      scannerDockerEnvironment(
        { ...validEnv, DOCKER_HOST: "unix:///var/run/docker.sock" },
        workerUid,
      ),
    ).toThrow("invalid rootless Docker configuration");
  });

  it("rejects a different user's Docker socket", () => {
    expect(() =>
      scannerDockerEnvironment(
        {
          ...validEnv,
          DOCKER_HOST: "unix:///run/user/999/docker.sock",
        },
        workerUid,
      ),
    ).toThrow("invalid rootless Docker configuration");
  });

  it("rejects an incorrect Docker configuration directory", () => {
    expect(() =>
      scannerDockerEnvironment(
        { ...validEnv, DOCKER_CONFIG: "/tmp/docker-config" },
        workerUid,
      ),
    ).toThrow("invalid rootless Docker configuration");
  });

  it("rejects a mismatched runtime directory", () => {
    expect(() =>
      scannerDockerEnvironment(
        { ...validEnv, XDG_RUNTIME_DIR: "/run/user/999" },
        workerUid,
      ),
    ).toThrow("invalid rootless Docker configuration");
  });

  it("does not forward application credentials", () => {
    const result = scannerDockerEnvironment(
      {
        ...validEnv,
        GITHUB_TOKEN: "private-github-token",
        BASETEN_API_KEY: "private-baseten-key",
        DATABASE_URL: "private-database-url",
      },
      workerUid,
    );

    expect(result.GITHUB_TOKEN).toBeUndefined();
    expect(result.BASETEN_API_KEY).toBeUndefined();
    expect(result.DATABASE_URL).toBeUndefined();
  });
});

describe("isolated scanner failure modes", () => {
  const image = `sha256:${"c".repeat(64)}`;
  const signal = new AbortController().signal;
  const absent: DockerCommand = async (args) =>
    args[0] === "container"
      ? { exitCode: 0, stdout: "", timedOut: false, failed: false }
      : { exitCode: 0, stdout: "{}", timedOut: false, failed: false };
  const stagedRoot = () => mkdtempSync(path.join(tmpdir(), "codearch-scan-failure-"));

  it("rejects an invalid image identity without staging a runner", async () => {
    await expect(runIsolatedScanner("/nonexistent", "node:latest", signal, absent)).rejects.toThrow(
      "Invalid scanner image identity.",
    );
  });

  it("reports a scan timeout with fixed text", async () => {
    const root = stagedRoot();
    try {
      const execute: DockerCommand = async (args) =>
        args[0] === "container"
          ? { exitCode: 0, stdout: "", timedOut: false, failed: false }
          : { exitCode: null, stdout: "", timedOut: true, failed: false };
      await expect(runIsolatedScanner(root, image, signal, execute)).rejects.toThrow(
        "Isolated scanner exceeded its 30-second limit.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a failed scan with fixed text", async () => {
    const root = stagedRoot();
    try {
      const execute: DockerCommand = async (args) =>
        args[0] === "container"
          ? { exitCode: 0, stdout: "", timedOut: false, failed: false }
          : { exitCode: 1, stdout: "", timedOut: false, failed: false };
      await expect(runIsolatedScanner(root, image, signal, execute)).rejects.toThrow(
        "Isolated scanner failed. Check Docker availability and scanner limits.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an unconfirmed container cleanup with fixed text", async () => {
    const root = stagedRoot();
    try {
      const execute: DockerCommand = async (args) =>
        args[0] === "rm"
          ? { exitCode: 0, stdout: "", timedOut: false, failed: false }
          : args[0] === "container"
            ? { exitCode: 0, stdout: "codearchaeologist-scan-lingering", timedOut: false, failed: false }
            : { exitCode: 0, stdout: "{}", timedOut: false, failed: false };
      await expect(runIsolatedScanner(root, image, signal, execute)).rejects.toThrow(
        "Isolated scanner cleanup could not be confirmed.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a cancelled scan before reporting output", async () => {
    const root = stagedRoot();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(runIsolatedScanner(root, image, controller.signal, absent)).rejects.toThrow(
        "GitHub analysis cancelled.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isolated runner staging", () => {
  it("stages a self-contained runner that scans without repository node_modules", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codearch-runner-closure-"));
    try {
      mkdirSync(path.join(root, "repo/application/controllers"), { recursive: true });
      writeFileSync(path.join(root, "repo/application/controllers/Gallery.php"), "<?php class Gallery extends CI_Controller { public function index() {} }\n");
      mkdirSync(path.join(root, "repo/assets/js"), { recursive: true });
      writeFileSync(path.join(root, "repo/assets/js/gallery.js"), "export function renderGallery(items) { return items.length; }\n");
      expect(await stageRunner(root)).toBe(path.join(root, "runner"));
      const script = `import("./runner/src/lib/archaeology/scanner.ts").then(async m => { const g = await m.scanRepository(${JSON.stringify(path.join(root, "repo"))}); console.log("files=" + g.scan.fileCount + " nodes=" + g.nodes.length); })`;
      const output = execFileSync(process.execPath, ["--experimental-transform-types", "--import", "./runner/scripts/register-types.mjs", "--eval", script], { cwd: root, timeout: 60_000, encoding: "utf8" });
      expect(output.trim()).toBe("files=2 nodes=5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
