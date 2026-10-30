import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertScannerProcessBoundary, dockerCommand, scannerAvailable, runIsolatedScanner } from "../src/lib/github-ingestion/sandbox";
import { executeDockerCommand } from "../src/lib/verification/docker-sandbox";

afterEach(() => vi.unstubAllEnvs());

describe("production web Docker boundary", () => {
  it("fails closed before either Docker command path can spawn a process", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(assertScannerProcessBoundary).toThrow(/worker identity/);
    await expect(dockerCommand(["info"], 1_000, 100)).rejects.toThrow(/worker identity/);
    await expect(executeDockerCommand(["info"], "", 1_000)).rejects.toThrow(/worker identity/);
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false, failed: false }));
    await expect(scannerAvailable(execute)).rejects.toThrow(/worker identity/);
    await expect(runIsolatedScanner("/tmp/unused", `sha256:${"a".repeat(64)}`, new AbortController().signal, execute)).rejects.toThrow(/worker identity/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("retains development scanner behavior", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(assertScannerProcessBoundary).not.toThrow();
  });
});
