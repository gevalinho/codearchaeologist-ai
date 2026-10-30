import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  dockerCommand,
  scannerDockerEnvironment,
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
