import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { GitHubJobPhase, GitHubJobStatus } from "../src/lib/github-ingestion/jobs";
import GitHubScanProgress, { appendObservedPhase, githubProgressState } from "../src/app/architecture/github-scan-progress";

const status = (phase: GitHubJobPhase, summary?: GitHubJobStatus["summary"]): GitHubJobStatus => ({ id: "job-one", phase, repository: "panique/huge", createdAt: "2026-10-29T08:00:00Z", expiresAt: "2026-10-29T08:05:00Z", ...(summary ? { summary } : {}) });
const render = (job: GitHubJobStatus | null, options: { submitting?: boolean; error?: string; observed?: GitHubJobPhase[]; ready?: boolean; featureCount?: number } = {}) => renderToStaticMarkup(createElement(GitHubScanProgress, { repository: "panique/php-login", startedAt: Date.now(), submitting: options.submitting ?? true, job, error: options.error ?? "", observed: options.observed ?? [], workspaceReady: options.ready ?? false, featureCount: options.featureCount, onCancel: () => undefined, onRetry: () => undefined }));

describe("GitHub investigation progress", () => {
  it("shows a submission state immediately without invented metrics or completion", () => {
    const html = render(null);
    expect(html).toContain("panique/php-login");
    expect(html).toContain("Submitting repository analysis");
    expect(html).not.toContain("analyzed files");
    expect(html).not.toContain("Feature candidates identified");
    expect(html).not.toContain("aria-valuenow");
  });
  it("advances only on observed phases and deduplicates repeated or stale polling", () => {
    const first = appendObservedPhase([], "validating-repository-url");
    expect(appendObservedPhase(first, "validating-repository-url")).toBe(first);
    const next = appendObservedPhase(first, "preparing-isolated-scanner");
    expect(appendObservedPhase(next, "validating-repository-url")).toBe(next);
    expect(appendObservedPhase(next, "fetching-repository")).toEqual(["validating-repository-url", "preparing-isolated-scanner", "fetching-repository"]);
    let many: GitHubJobPhase[] = [];
    for (const phase of ["validating-repository-url", "preparing-isolated-scanner", "fetching-repository", "scanning-supported-source-files", "generating-architecture-graph", "validating-graph", "ready"] as GitHubJobPhase[]) many = appendObservedPhase(many, phase);
    expect(many).toHaveLength(6);
    const html = render(status("fetching-repository"), { observed: ["validating-repository-url", "preparing-isolated-scanner", "fetching-repository"] });
    expect(html).toContain("Acquiring source");
    expect(html).toContain("Sandbox security verified · source acquisition started");
    expect(html).not.toContain("Source acquisition completed");
    expect(render(status("scanning-supported-source-files"), { observed: ["scanning-supported-source-files"] })).toContain("Source acquisition completed · isolated scan started");
  });
  it("marks the actual failed stage and keeps the server error with a retry action", () => {
    const observed: GitHubJobPhase[] = ["preparing-isolated-scanner", "fetching-repository", "failed"];
    const state = githubProgressState(status("failed"), false, "GitHub tree is incomplete.", false, observed);
    expect(state.activeLabel).toBe("Acquiring source");
    const html = render(status("failed"), { submitting: false, error: "GitHub tree is incomplete.", observed });
    expect(html).toContain("Stopped during acquiring source");
    expect(html).toContain("GitHub tree is incomplete.");
    expect(html).toContain("Retry analysis");
    expect(html).not.toContain("github-progress is-active");
  });
  it("does not start a second scan when polling fails but the server job may still be active", () => {
    const html = render(status("fetching-repository"), { submitting: false, error: "Could not reach the status endpoint.", observed: ["fetching-repository"] });
    expect(html).toContain("Cancel server job");
    expect(html).toContain("Server status is uncertain");
    expect(html).not.toContain("Retry analysis");
  });
  it("waits for artifact handoff before claiming success and shows only final measured counts", () => {
    const summary = { scannedFiles: 64, scannedBytes: 12345, eligibleFiles: 450, selectedFiles: 300, omittedFiles: 150, skippedFiles: 700, coverage: "partial-supported-source" as const, nodes: 672, edges: 1797, warnings: 0 };
    const pending = render(status("ready", summary), { observed: ["ready"] });
    expect(pending).toContain("Preparing investigation workspace");
    expect(pending).not.toContain("Investigation workspace ready");
    expect(pending).toContain("64</b> analyzed files");
    expect(pending).toContain("450</b> eligible files");
    expect(pending).toContain("300</b> selected files");
    expect(pending).toContain("150</b> omitted files");
    const done = render(status("ready", summary), { submitting: false, observed: ["ready"], ready: true, featureCount: 9 });
    expect(done).toContain("Investigation workspace ready");
    expect(done).toContain("9</b> feature candidates");
    expect(done).toContain("Partial supported-source assessment");
  });
  it("renders bounded phase timing and blob counts without request details", () => {
    const job = { ...status("fetching-repository"), diagnostics: { selectedBlobs: 300, completedBlobs: 42, failedBlobs: 0, dockerReadinessMs: 12, metadataCommitMs: 25, treeMs: 40, selectionMs: 3, blobAcquisitionMs: 1800 } };
    const html = render(job);
    expect(html).toContain("300 selected blobs · 42 completed · 0 failed");
    expect(html).toContain("Metadata and commit: 25 ms");
    expect(html).toContain("Blob acquisition: 1800 ms");
    expect(html).not.toContain("raw.githubusercontent.com");
    expect(html).not.toContain("Authorization");
  });
  it("disables animation for reduced motion in the component stylesheet", () => {
    const css = readFileSync("src/app/architecture/github-scan-progress.css", "utf8");
    expect(css).toContain("@media(prefers-reduced-motion:reduce)");
    expect(css).toContain(".github-progress.is-active .github-progress-track span{animation:none}");
  });
});
