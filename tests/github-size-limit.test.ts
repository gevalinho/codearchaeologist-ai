import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitHubJobManager, REPOSITORY_SIZE_LIMIT_MESSAGE, toUserFacingJobError, type JobDependencies } from "../src/lib/github-ingestion/jobs";
import { GITHUB_RESPONSE_TOO_LARGE_MESSAGE, fixedHostFetch } from "../src/lib/github-ingestion/network";
import GitHubScanProgress from "../src/app/architecture/github-scan-progress";
import type { GitHubJobStatus } from "../src/lib/github-ingestion/jobs";

vi.mock("server-only", () => ({}));

const temporaryRoots: string[] = [];
const originalDb = process.env.CODEARCH_DB_PATH, originalArtifacts = process.env.CODEARCH_ARTIFACT_DIR;
beforeEach(() => { const root = mkdtempSync(path.join(tmpdir(), "github-size-limit-test-")); temporaryRoots.push(root); mkdirSync(path.join(root, "artifacts"), { mode: 0o700 }); process.env.CODEARCH_DB_PATH = path.join(root, "state.sqlite"); process.env.CODEARCH_ARTIFACT_DIR = path.join(root, "artifacts"); });
afterEach(async () => { if (originalDb === undefined) delete process.env.CODEARCH_DB_PATH; else process.env.CODEARCH_DB_PATH = originalDb; if (originalArtifacts === undefined) delete process.env.CODEARCH_ARTIFACT_DIR; else process.env.CODEARCH_ARTIFACT_DIR = originalArtifacts; await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.restoreAllMocks(); });
const temp = async () => { const root = await mkdtemp(path.join(tmpdir(), "github-size-limit-stage-")); temporaryRoots.push(root); return root; };
const dependencies = (overrides: Partial<JobDependencies> = {}): JobDependencies => ({ available: async () => "sha256:test", acquire: async () => { throw new Error("unused acquire"); }, scan: async () => { throw new Error("unused scan"); }, temporary: temp, cleanup: root => rm(root, { recursive: true, force: true }), now: Date.now, authorize: async () => null, token: async () => "installation-token", ...overrides });

describe("GitHub response size-limit error mapping", () => {
  it("maps only the GitHub response size-limit failure to the actionable user message", () => {
    expect(GITHUB_RESPONSE_TOO_LARGE_MESSAGE).toBe("GitHub response exceeds the size limit.");
    expect(toUserFacingJobError(new Error(GITHUB_RESPONSE_TOO_LARGE_MESSAGE))).toBe(REPOSITORY_SIZE_LIMIT_MESSAGE);
    expect(REPOSITORY_SIZE_LIMIT_MESSAGE).toContain("Repository exceeds the analysis size limit.");
    expect(REPOSITORY_SIZE_LIMIT_MESSAGE).toContain("more data than CodeArchaeologist AI can safely retrieve in a single investigation");
    expect(REPOSITORY_SIZE_LIMIT_MESSAGE).toContain("Try analyzing a smaller repository or preparing a reduced copy");
  });

  it("leaves unrelated acquisition errors and the unknown-error fallback unchanged", () => {
    for (const message of ["GitHub request timed out.", "GitHub tree is incomplete or exceeds the tree limit.", "Eligible source files exceed the scanner byte limits.", "Downloaded source exceeds the scanner byte limit.", "Artifact exceeds the size limit.", "Docker sandbox unavailable."]) {
      expect(toUserFacingJobError(new Error(message))).toBe(message);
    }
    expect(toUserFacingJobError(undefined)).toBe("GitHub analysis failed.");
    expect(toUserFacingJobError(null)).toBe("GitHub analysis failed.");
  });

  it("stores the improved message on the failed job without changing the failure path", async () => {
    const manager = new GitHubJobManager(dependencies({ acquire: async () => { throw new Error(GITHUB_RESPONSE_TOO_LARGE_MESSAGE); } }));
    const job = manager.create("https://github.com/example/repo");
    await manager.wait(job.id);
    expect(manager.get(job.id)).toMatchObject({ phase: "failed", error: REPOSITORY_SIZE_LIMIT_MESSAGE });
    expect(await manager.artifact(job.id, "graph.json")).toBeUndefined();
  });

  it("stores unrelated acquisition errors verbatim on the failed job", async () => {
    const manager = new GitHubJobManager(dependencies({ acquire: async () => { throw new Error("GitHub request timed out."); } }));
    const job = manager.create("https://github.com/example/repo");
    await manager.wait(job.id);
    expect(manager.get(job.id)).toMatchObject({ phase: "failed", error: "GitHub request timed out." });
  });

  it("shows the failed investigation status, progress indicator, and retry action with the improved message", () => {
    const job: GitHubJobStatus = { id: "job-size-limit", phase: "failed", repository: "example/huge", createdAt: "2026-11-02T00:00:00Z", expiresAt: "2026-11-02T00:05:00Z", error: REPOSITORY_SIZE_LIMIT_MESSAGE };
    const html = renderToStaticMarkup(createElement(GitHubScanProgress, { repository: "example/huge", startedAt: Date.now(), submitting: false, job, error: REPOSITORY_SIZE_LIMIT_MESSAGE, observed: ["validating-repository-url", "preparing-isolated-scanner", "fetching-repository", "failed"], workspaceReady: false, onCancel: () => undefined, onRetry: () => undefined }));
    expect(html).toContain("STOPPED");
    expect(html).toContain("Stopped during acquiring source");
    expect(html).toContain("Repository exceeds the analysis size limit.");
    expect(html).toContain("preparing a reduced copy");
    expect(html).toContain("Retry analysis");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("Scan stopped");
    expect(html).toContain("github-progress-error");
  });

  it("keeps existing response limits enforced and exposes no internal paths or secrets", async () => {
    const signal = new AbortController().signal;
    await expect(fixedHostFetch("api.github.com", "/repos/example/repo", 8 * 1024 * 1024 + 1, signal)).rejects.toThrow(/Invalid GitHub request/);
    await expect(fixedHostFetch("api.github.com", "//metadata.internal/latest", 100, signal)).rejects.toThrow(/Invalid/);
    for (const leaked of ["CODEARCH_", "Bearer", ".env", "/tmp/", "/repos/", "raw.githubusercontent", "api.github", "content-length", "maxBytes"]) {
      expect(REPOSITORY_SIZE_LIMIT_MESSAGE).not.toContain(leaked);
    }
  });
});
