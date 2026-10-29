import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquirePublicRepository } from "../src/lib/github-ingestion/acquire";
import { GitHubJobManager, type JobDependencies } from "../src/lib/github-ingestion/jobs";
import { approvedRepositoryMove, fixedHostFetch, pinnedLookup, pinnedPublicAddress, publicIPv4, requireSuccessfulGitHubStatus, type FixedHostFetch } from "../src/lib/github-ingestion/network";
import { parsePublicGitHubUrl } from "../src/lib/github-ingestion/url";
import { authorizeGitHubJob } from "../src/lib/github-ingestion/access";
import { dockerCommand, runIsolatedScanner, scannerAvailable, type DockerCommand } from "../src/lib/github-ingestion/sandbox";
import { parseGraph } from "../src/lib/architecture/graph";
import { scanRepository } from "../src/lib/archaeology/scanner";
import type { AcquisitionDiagnostics } from "../src/lib/github-ingestion/acquire";
import demoGraph from "./fixtures/architecture/demo-graph.json";

vi.mock("server-only", () => ({}));

const temporaryRoots: string[] = [];
const originalDb = process.env.CODEARCH_DB_PATH, originalArtifacts = process.env.CODEARCH_ARTIFACT_DIR;
beforeEach(() => { const root = mkdtempSync(path.join(tmpdir(), "github-job-state-test-")); temporaryRoots.push(root); mkdirSync(path.join(root, "artifacts"), { mode: 0o700 }); process.env.CODEARCH_DB_PATH = path.join(root, "state.sqlite"); process.env.CODEARCH_ARTIFACT_DIR = path.join(root, "artifacts"); });
afterEach(async () => { if (originalDb === undefined) delete process.env.CODEARCH_DB_PATH; else process.env.CODEARCH_DB_PATH = originalDb; if (originalArtifacts === undefined) delete process.env.CODEARCH_ARTIFACT_DIR; else process.env.CODEARCH_ARTIFACT_DIR = originalArtifacts; await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const temp = async () => { const root = await mkdtemp(path.join(tmpdir(), "github-ingestion-test-")); temporaryRoots.push(root); return root; };
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const commitSha = "a".repeat(40), treeSha = "b".repeat(40);

function fixtureFetch(files: Record<string, string>, extra: { path: string; mode: string; type: string; sha: string; size?: number }[] = [], reportedSize = 1): FixedHostFetch {
  const entries = Object.entries(files).map(([name, text]) => { const bytes = Buffer.from(text); return { path: name, mode: "100644", type: "blob", sha: blobSha(bytes), size: bytes.length }; });
  return async (host, requestPath) => {
    if (host === "api.github.com" && requestPath === "/repos/example/repo") return encoded({ private: false, default_branch: "main", size: reportedSize });
    if (host === "api.github.com" && requestPath.endsWith("/commits/main")) return encoded({ sha: commitSha, commit: { tree: { sha: treeSha } } });
    if (host === "api.github.com" && requestPath.includes("/git/trees/")) return encoded({ sha: treeSha, truncated: false, tree: [...entries, ...extra] });
    const match = Object.entries(files).find(([name]) => requestPath === `/example/repo/${commitSha}/${name.split("/").map(encodeURIComponent).join("/")}`);
    if (host === "raw.githubusercontent.com" && match) return Buffer.from(match[1]);
    throw new Error(`Unexpected test request: ${host}${requestPath}`);
  };
}

describe("public GitHub URL and network boundary", () => {
  it("returns the Node.js 24 all-address lookup shape while retaining the single-address signature", () => {
    const lookup = pinnedLookup("140.82.112.3");
    lookup("github.com", { all: true }, (error, result, family) => {
      expect(error).toBeNull();
      expect(result).toEqual([{ address: "140.82.112.3", family: 4 }]);
      expect(family).toBeUndefined();
    });
    lookup("github.com", { all: false }, (error, result, family) => {
      expect(error).toBeNull(); expect(result).toBe("140.82.112.3"); expect(family).toBe(4);
    });
    lookup("github.com", {}, (error, result, family) => {
      expect(error).toBeNull(); expect(result).toBe("140.82.112.3"); expect(family).toBe(4);
    });
  });
  it("accepts only canonical repository URLs", () => {
    expect(parsePublicGitHubUrl("https://github.com/example/repo").canonicalUrl).toBe("https://github.com/example/repo");
    for (const url of ["http://github.com/example/repo", "https://github.com.evil.test/example/repo", "https://user:pass@github.com/example/repo", "https://github.com/example/repo/tree/main", "https://github.com/example/repo.git", "https://github.com/example/repo?x=1", "https://github.com/example/%72epo", "https://github.com/example/repo#x", "https://github.com:443/example/repo"]) expect(() => parsePublicGitHubUrl(url)).toThrow();
  });
  it("rejects private, mixed, and redirect destinations", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "224.0.0.1", "not-an-ip"]) expect(publicIPv4(address)).toBe(false);
    expect(publicIPv4("140.82.112.3")).toBe(true);
    expect(() => pinnedPublicAddress(["140.82.112.3", "127.0.0.1"])).toThrow();
    expect(() => requireSuccessfulGitHubStatus(302)).toThrow(/redirected/);
    expect(() => requireSuccessfulGitHubStatus(429)).toThrow(/rate limit/);
    expect(() => requireSuccessfulGitHubStatus(404)).toThrow(/not found/);
  });
  it("allows only one narrowly shaped public repository metadata move", () => {
    const move = { repositoryMove: true as const };
    expect(approvedRepositoryMove("api.github.com", "/repos/panique/php-login", 301, "https://api.github.com/repositories/4237727", move)).toBe("/repositories/4237727");
    for (const location of ["https://evil.example/repositories/4237727", "https://127.0.0.1/repositories/4237727", "https://169.254.169.254/latest/meta-data", "http://api.github.com/repositories/4237727", "https://api.github.com.evil.example/repositories/4237727", "https://api.github.com/repositories/4237727/extra", "https://api.github.com/repositories/4237727?x=1", "https://api.github.com/repos/panique/php-login"]) expect(approvedRepositoryMove("api.github.com", "/repos/panique/php-login", 301, location, move)).toBeNull();
    expect(approvedRepositoryMove("api.github.com", "/repos/panique/php-login", 302, "https://api.github.com/repositories/4237727", move)).toBeNull();
    expect(approvedRepositoryMove("api.github.com", "/repositories/4237727", 301, "https://api.github.com/repositories/4237727", move)).toBeNull();
    expect(approvedRepositoryMove("api.github.com", "/repos/panique/php-login", 301, "https://api.github.com/repositories/4237727", { ...move, bearer: "private-token" })).toBeNull();
    expect(approvedRepositoryMove("raw.githubusercontent.com", "/repos/panique/php-login", 301, "https://api.github.com/repositories/4237727", move)).toBeNull();
  });
  it("refuses user-controlled hosts and ambiguous request paths before DNS", async () => {
    const signal = new AbortController().signal;
    await expect(fixedHostFetch("evil.example" as "api.github.com", "/repo", 100, signal)).rejects.toThrow(/Unapproved/);
    await expect(fixedHostFetch("api.github.com", "//metadata.internal/latest", 100, signal)).rejects.toThrow(/Invalid/);
  });
});

describe("bounded source acquisition", () => {
  const repo = parsePublicGitHubUrl("https://github.com/example/repo");
  it("downloads only eligible regular source files and verifies their blob hashes", async () => {
    const root = await temp();
    const fetch = vi.fn(fixtureFetch({ "application/controllers/Demo.php": "<?php class Demo {}", "README.md": "ignore", ".git/config": "ignore", "vendor/Other.php": "ignore" }, [{ path: "application/controllers/Link.php", mode: "120000", type: "blob", sha: "c".repeat(40), size: 4 }]));
    const result = await acquirePublicRepository(repo, path.join(root, "repo"), new AbortController().signal, fetch);
    expect(result).toMatchObject({ sourceFiles: 1, skippedFiles: 4, treeEntries: 5 });
    expect(await readFile(path.join(root, "repo/application/controllers/Demo.php"), "utf8")).toBe("<?php class Demo {}");
    expect(fetch.mock.calls.filter(call => call[0] === "raw.githubusercontent.com")).toHaveLength(1);
  });
  it("uses GitHub's canonical public repository name after a metadata move", async () => {
    const root = await temp();
    const source = Buffer.from("<?php class Demo {}");
    const seen: string[] = [];
    const fetch: FixedHostFetch = async (host, requestPath, _limit, _signal, options) => {
      seen.push(`${host}${requestPath}`);
      if (requestPath === "/repos/panique/php-login") { expect(options?.repositoryMove).toBe(true); return encoded({ private: false, full_name: "panique/huge", default_branch: "master", size: 1 }); }
      if (requestPath === "/repos/panique/huge/commits/master") return encoded({ sha: commitSha, commit: { tree: { sha: treeSha } } });
      if (requestPath === `/repos/panique/huge/git/trees/${treeSha}?recursive=1`) return encoded({ sha: treeSha, truncated: false, tree: [{ path: "application/Demo.php", mode: "100644", type: "blob", sha: blobSha(source), size: source.length }] });
      if (host === "raw.githubusercontent.com" && requestPath === `/panique/huge/${commitSha}/application/Demo.php`) return source;
      throw new Error("Unexpected canonical request");
    };
    const result = await acquirePublicRepository(parsePublicGitHubUrl("https://github.com/panique/php-login"), path.join(root, "moved"), new AbortController().signal, fetch);
    expect(result.sourceFiles).toBe(1);
    expect(seen).toContain(`raw.githubusercontent.com/panique/huge/${commitSha}/application/Demo.php`);
  });
  it("accepts a repository reported above 100 MB when eligible source fits the bounded scanner", async () => {
    const root = await temp();
    const fetch = vi.fn(fixtureFetch({ "application/controllers/Demo.php": "<?php class Demo {}", "assets/video/large.mp4": "not source" }, [], 250_000));
    const result = await acquirePublicRepository(repo, path.join(root, "large"), new AbortController().signal, fetch);
    expect(result).toMatchObject({ sourceFiles: 1, skippedFiles: 1, sourceBytes: 19, treeEntries: 2 });
    expect(fetch.mock.calls.filter(call => call[0] === "raw.githubusercontent.com")).toHaveLength(1);
  });
  it("selects at most 300 eligible files after filtering, without downloading omitted source", async () => {
    const root = await temp();
    const files = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`application/controllers/Demo${i}.php`, `<?php class Demo${i} {}`]));
    files["vendor/Library.php"] = "ignored";
    const fetch = vi.fn(fixtureFetch(files));
    const result = await acquirePublicRepository(repo, path.join(root, "repo"), new AbortController().signal, fetch);
    expect(result).toMatchObject({ eligibleFiles: 301, sourceFiles: 300, omittedFiles: 1, skippedFiles: 1 });
    expect(fetch.mock.calls.filter(call => call[0] === "raw.githubusercontent.com")).toHaveLength(300);
  });
  it("rejects a source size over the scanner limit", async () => {
    const root = await temp();
    const fetch = vi.fn(fixtureFetch({}, [{ path: "application/controllers/Huge.php", mode: "100644", type: "blob", sha: "c".repeat(40), size: 2 * 1024 * 1024 + 1 }]));
    await expect(acquirePublicRepository(repo, path.join(root, "repo"), new AbortController().signal, fetch)).rejects.toThrow(/byte limits/);
    expect(fetch.mock.calls.some(call => call[0] === "raw.githubusercontent.com")).toBe(false);
  });
  it("rejects changed content and interrupted acquisition", async () => {
    const root = await temp();
    const correct = fixtureFetch({ "application/controllers/Demo.php": "<?php class Demo {}" });
    await expect(acquirePublicRepository(repo, path.join(root, "wrong"), new AbortController().signal, async (host, requestPath, maxBytes, signal) => host === "raw.githubusercontent.com" ? Buffer.from("changed") : correct(host, requestPath, maxBytes, signal))).rejects.toThrow(/did not match/);
    const controller = new AbortController(); controller.abort();
    await expect(acquirePublicRepository(repo, path.join(root, "cancel"), controller.signal, async () => { throw new Error("GitHub acquisition cancelled."); })).rejects.toThrow(/cancelled/);
  });
  it("rejects incomplete trees and acquisition failures", async () => {
    const root = await temp();
    const base = fixtureFetch({ "application/controllers/Demo.php": "<?php class Demo {}" });
    await expect(acquirePublicRepository(repo, path.join(root, "truncated"), new AbortController().signal, async (host, requestPath, limit, signal) => requestPath.includes("/git/trees/") ? encoded({ truncated: true, tree: [] }) : base(host, requestPath, limit, signal))).rejects.toThrow(/incomplete/);
    await expect(acquirePublicRepository(repo, path.join(root, "wrong-tree"), new AbortController().signal, async (host, requestPath, limit, signal) => requestPath.includes("/git/trees/") ? encoded({ sha: "c".repeat(40), truncated: false, tree: [] }) : base(host, requestPath, limit, signal))).rejects.toThrow(/incomplete/);
    await expect(acquirePublicRepository(repo, path.join(root, "malformed-excluded"), new AbortController().signal, async (host, requestPath, limit, signal) => requestPath.includes("/git/trees/") ? encoded({ sha: treeSha, truncated: false, tree: [{ path: "vendor/Invalid.php", type: "blob", mode: "100644", sha: "c".repeat(40), size: "unknown" }] }) : base(host, requestPath, limit, signal))).rejects.toThrow(/metadata/);
    await expect(acquirePublicRepository(repo, path.join(root, "missing"), new AbortController().signal, async (host, requestPath, limit, signal) => requestPath.includes("/git/trees/") ? encoded({ sha: treeSha, truncated: false, tree: [{ path: "application/controllers/Demo.php", type: "blob", mode: "100644", sha: blobSha(Buffer.from("<?php class Demo {}")), size: 19 }, { path: "application/controllers/Demo.php", type: "blob", mode: "100644", sha: blobSha(Buffer.from("<?php class Demo {}")), size: 19 }] }) : base(host, requestPath, limit, signal))).rejects.toThrow(/duplicate/);
    await expect(acquirePublicRepository(repo, path.join(root, "network"), new AbortController().signal, async (host, requestPath, limit, signal) => host === "raw.githubusercontent.com" ? Promise.reject(new Error("GitHub request timed out.")) : base(host, requestPath, limit, signal))).rejects.toThrow(/timed out/);
  });
  it("runs at most four public blob requests and produces the same artifact despite completion order", async () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`application/controllers/Thing${index}.php`, `<?php class Thing${index} {}`]));
    const base = fixtureFetch(files);
    async function run(reverse: boolean) {
      const root = await temp(), destination = path.join(root, "repo");
      let active = 0, maximum = 0;
      const samples: AcquisitionDiagnostics[] = [];
      const fetch: FixedHostFetch = async (host, requestPath, limit, signal, options) => {
        if (host !== "raw.githubusercontent.com") return base(host, requestPath, limit, signal, options);
        active++; maximum = Math.max(maximum, active);
        const number = Number(requestPath.match(/Thing(\d+)\.php$/)?.[1] ?? 0);
        try { await new Promise(resolve => setTimeout(resolve, reverse ? (12 - number) * 2 : number * 2)); return await base(host, requestPath, limit, signal, options); }
        finally { active--; }
      };
      const result = await acquirePublicRepository(repo, destination, new AbortController().signal, fetch, undefined, sample => samples.push(sample));
      return { maximum, result, samples, graph: await scanRepository(destination) };
    }
    const first = await run(false), second = await run(true);
    expect(first.maximum).toBe(4);
    expect(second.maximum).toBe(4);
    expect(first.graph.snapshotId).toBe(second.graph.snapshotId);
    expect(first.graph.nodes).toEqual(second.graph.nodes);
    expect(first.result.sourceFiles).toBe(12);
    expect(first.samples.at(-1)).toMatchObject({ selectedBlobs: 12, completedBlobs: 12, failedBlobs: 0 });
    expect(first.samples.at(-1)?.blobAcquisitionMs).toBeGreaterThanOrEqual(0);
  });
  it("aborts other workers, stops scheduling, and cleans partial files after a blob failure", async () => {
    const root = await temp(), destination = path.join(root, "repo");
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`application/controllers/Thing${index}.php`, `<?php class Thing${index} {}`]));
    const base = fixtureFetch(files);
    let started = 0, aborted = 0;
    const samples: AcquisitionDiagnostics[] = [];
    const fetch: FixedHostFetch = async (host, requestPath, limit, signal, options) => {
      if (host !== "raw.githubusercontent.com") return base(host, requestPath, limit, signal, options);
      started++;
      if (requestPath.endsWith("Thing0.php")) { await new Promise(resolve => setTimeout(resolve, 5)); throw new Error("fixture blob failure"); }
      return new Promise<Buffer>((_resolve, reject) => {
        if (signal.aborted) { aborted++; reject(new Error("cancelled")); return; }
        signal.addEventListener("abort", () => { aborted++; reject(new Error("cancelled")); }, { once: true });
      });
    };
    await expect(acquirePublicRepository(repo, destination, new AbortController().signal, fetch, undefined, sample => samples.push(sample))).rejects.toThrow("fixture blob failure");
    expect(started).toBe(4);
    expect(aborted).toBe(3);
    expect(samples.at(-1)?.failedBlobs).toBe(4);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("propagates user cancellation to all active blob requests and removes staging", async () => {
    const root = await temp(), destination = path.join(root, "repo"), controller = new AbortController();
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`application/controllers/Thing${index}.php`, `<?php class Thing${index} {}`]));
    const base = fixtureFetch(files);
    let started = 0, aborted = 0;
    const fetch: FixedHostFetch = async (host, requestPath, limit, signal, options) => {
      if (host !== "raw.githubusercontent.com") return base(host, requestPath, limit, signal, options);
      started++;
      if (started === 4) queueMicrotask(() => controller.abort());
      return new Promise<Buffer>((_resolve, reject) => signal.addEventListener("abort", () => { aborted++; reject(new Error("GitHub acquisition cancelled.")); }, { once: true }));
    };
    await expect(acquirePublicRepository(repo, destination, controller.signal, fetch)).rejects.toThrow(/cancelled/);
    expect(started).toBe(4);
    expect(aborted).toBe(4);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("removes already written files when a later blob fails", async () => {
    const root = await temp(), destination = path.join(root, "repo");
    const base = fixtureFetch({ "application/controllers/A.php": "<?php class A {}", "application/controllers/B.php": "<?php class B {}" });
    const fetch: FixedHostFetch = async (host, requestPath, limit, signal, options) => {
      if (host === "raw.githubusercontent.com" && requestPath.endsWith("B.php")) { await new Promise(resolve => setTimeout(resolve, 15)); throw new Error("later failure"); }
      return base(host, requestPath, limit, signal, options);
    };
    await expect(acquirePublicRepository(repo, destination, new AbortController().signal, fetch)).rejects.toThrow("later failure");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects aggregate source bytes before launching concurrent downloads", async () => {
    const root = await temp();
    const oversized = Array.from({ length: 7 }, (_, index) => ({ path: `application/controllers/Huge${index}.php`, mode: "100644", type: "blob", sha: "c".repeat(40), size: 2 * 1024 * 1024 }));
    const fetch = vi.fn(fixtureFetch({}, oversized));
    await expect(acquirePublicRepository(repo, path.join(root, "repo"), new AbortController().signal, fetch)).rejects.toThrow(/byte limits/);
    expect(fetch.mock.calls.some(call => call[0] === "raw.githubusercontent.com")).toBe(false);
  });
});

describe("server authorization and sandbox", () => {
  it("requires enablement, exact origin, and the access key", async () => {
    const previous = { enabled: process.env.ENABLE_GITHUB_INGESTION, origin: process.env.GITHUB_INGESTION_ORIGIN, key: process.env.GITHUB_INGESTION_ACCESS_KEY };
    try {
      process.env.ENABLE_GITHUB_INGESTION = "1";
      process.env.GITHUB_INGESTION_ORIGIN = "https://investigate.example";
      process.env.GITHUB_INGESTION_ACCESS_KEY = "a".repeat(32);
      const request = (origin: string, key: string) => new Request("https://investigate.example/api/github-jobs", { method: "POST", headers: { origin, "x-codearchaeologist-access-key": key } });
      expect(authorizeGitHubJob(request("https://investigate.example", "a".repeat(32)), true)).toBeNull();
      expect(authorizeGitHubJob(request("https://evil.example", "a".repeat(32)), true)?.status).toBe(403);
      expect(authorizeGitHubJob(request("https://investigate.example", "bad"), true)?.status).toBe(401);
      delete process.env.ENABLE_GITHUB_INGESTION;
      expect(authorizeGitHubJob(request("https://investigate.example", "a".repeat(32)), true)?.status).toBe(503);
    } finally {
      for (const [key, value] of Object.entries({ ENABLE_GITHUB_INGESTION: previous.enabled, GITHUB_INGESTION_ORIGIN: previous.origin, GITHUB_INGESTION_ACCESS_KEY: previous.key })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  it("requires Docker seccomp and a preinstalled image", async () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const success = (stdout: string) => ({ exitCode: 0, stdout, timedOut: false, failed: false });
    const execute = (security: string, baseline = 2, enforced = 3): DockerCommand => async args => args[0] === "info" ? success(security) : args[0] === "image" ? success(imageId) : args.includes("--security-opt=seccomp=unconfined") ? success(`Seccomp:2\nSeccomp_filters:${baseline}\n`) : success(`Seccomp:2\nSeccomp_filters:${enforced}\n`);
    expect(await scannerAvailable(execute('["name=seccomp,profile=builtin"]'))).toBe(imageId);
    expect(await scannerAvailable(execute('["name=seccomp,profile=unconfined"]'))).toBe(imageId);
    expect(await scannerAvailable(execute('["name=seccomp"]'))).toBe(imageId);
    await expect(scannerAvailable(async () => ({ exitCode: 1, stdout: "", timedOut: false, failed: true }))).rejects.toThrow(/unavailable/);
    for (const security of ["[]", '["name=seccomp,profile=unconfined-extra,unsupported=true"]', '["not-seccomp"]', "not-json"]) await expect(scannerAvailable(execute(security))).rejects.toThrow(/seccomp|unreadable/);
    await expect(scannerAvailable(execute('["name=seccomp,profile=unconfined"]', 2, 2))).rejects.toThrow(/enforcement could not be verified/);
    await expect(scannerAvailable(execute('["name=seccomp,profile=builtin"]', 2, 1))).rejects.toThrow(/enforcement could not be verified/);
    const base = execute('["name=seccomp,profile=unconfined"]');
    const unsupported: DockerCommand = async (args, timeout, limit) => args.includes("--security-opt=seccomp=builtin") ? { exitCode: 1, stdout: "", timedOut: false, failed: true } : base(args, timeout, limit);
    await expect(scannerAvailable(unsupported)).rejects.toThrow(/enforcement could not be verified/);
    const malformedProbe: DockerCommand = async (args, timeout, limit) => args.includes("--security-opt=seccomp=builtin") ? success("Seccomp:0\nSeccomp_filters:0\n") : base(args, timeout, limit);
    await expect(scannerAvailable(malformedProbe)).rejects.toThrow(/enforcement could not be verified/);
  });
  it("uses a non-root network-disabled read-only worker and reports timeouts", async () => {
    const root = await temp();
    const imageId = `sha256:${"a".repeat(64)}`;
    const commands: string[][] = [];
    const execute: DockerCommand = async args => {
      commands.push(args);
      if (args[0] === "run") return { exitCode: null, stdout: "", timedOut: true, failed: false };
      return { exitCode: 0, stdout: "", timedOut: false, failed: false };
    };
    await expect(runIsolatedScanner(root, imageId, new AbortController().signal, execute)).rejects.toThrow(/30-second/);
    expect(commands[0]).toEqual(expect.arrayContaining(["--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--security-opt=seccomp=builtin", "--memory=256m"]));
    expect(commands[0].some(arg => arg.includes("docker.sock"))).toBe(false);
  });
  it.skipIf(process.env.RUN_LIVE_DOCKER !== "1")("verifies a real enforcing scanner profile without touching application containers", async () => {
    expect(await scannerAvailable(dockerCommand)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("analysis job lifecycle", () => {
  const repoUrl = "https://github.com/example/repo";
  const graphJson = JSON.stringify(demoGraph);
  function dependencies(overrides: Partial<JobDependencies> = {}): JobDependencies {
    return { available: async () => "sha256:test", acquire: async () => ({ sourceFiles: 2, eligibleFiles: 2, omittedFiles: 0, sourceBytes: 220, skippedFiles: 6, treeEntries: 8, commitSha }), scan: async () => graphJson, temporary: temp, cleanup: root => rm(root, { recursive: true, force: true }), now: Date.now, authorize: async () => null, token: async () => "installation-token", ...overrides };
  }
  it("validates graph and manifest, exposes only completed artifacts, and cleans staging", async () => {
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const manager = new GitHubJobManager(dependencies({ cleanup: async root => { await cleanupGate; await rm(root, { recursive: true, force: true }); } }));
    const job = manager.create(repoUrl);
    for (let i = 0; i < 20 && manager.get(job.id)?.phase !== "validating-graph"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(await manager.artifact(job.id, "graph.json")).toBeUndefined();
    releaseCleanup(); await manager.wait(job.id);
    expect(manager.get(job.id)).toMatchObject({ phase: "ready", repository: "example/repo", summary: { scannedFiles: 2, scannedBytes: 220, skippedFiles: 6, coverage: "partial-supported-source" } });
    expect(manager.get(job.id)?.diagnostics).toMatchObject({ selectedBlobs: 0, completedBlobs: 0, failedBlobs: 0, dockerReadinessMs: expect.any(Number), sandboxScanMs: expect.any(Number), graphValidationMs: expect.any(Number) });
    const parsed = parseGraph((await manager.artifact(job.id, "graph.json"))!);
    expect(parsed.snapshotId).toBe(demoGraph.snapshotId);
    expect(parsed.sourceCoverage).toEqual({ eligibleFiles: 2, selectedFiles: 2, omittedFiles: 0, analyzedFiles: 2, skippedFiles: 6, partial: true });
    const manifest = JSON.parse((await manager.artifact(job.id, "manifest.json"))!);
    expect(manifest.snapshotId).toBe(demoGraph.snapshotId);
    expect(manifest.repositoryDisplayName).toBe("example/repo");
    expect(manifest.coverageLimitations).toEqual(expect.arrayContaining([expect.stringContaining("excluded or unsupported: 6")]));
  });
  it("cancels active work, prevents concurrent jobs, and removes staging", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleanup = vi.fn(async (root: string) => rm(root, { recursive: true, force: true }));
    const manager = new GitHubJobManager(dependencies({ scan: async () => { await gate; return graphJson; }, cleanup }));
    const job = manager.create(repoUrl);
    await vi.waitFor(() => expect(manager.get(job.id)?.phase).toBe("scanning-supported-source-files"));
    expect(() => manager.create(repoUrl)).toThrow(/already running/);
    expect(manager.cancel(job.id)?.phase).toBe("cancelled");
    release(); await manager.wait(job.id);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(await manager.artifact(job.id, "graph.json")).toBeUndefined();
  });
  it("propagates the unchanged 90-second job deadline into acquisition", async () => {
    const root = await temp();
    let acquisitionStarted!: () => void;
    const started = new Promise<void>(resolve => { acquisitionStarted = resolve; });
    const cleanup = vi.fn(async () => undefined);
    vi.useFakeTimers();
    try {
      const manager = new GitHubJobManager(dependencies({ temporary: async () => root, cleanup, acquire: async (_repo, _destination, signal, _fetch, _token, onProgress) => {
        onProgress?.({ selectedBlobs: 4, completedBlobs: 1, failedBlobs: 0, metadataCommitMs: 4, treeMs: 9, selectionMs: 1, blobAcquisitionMs: 10 });
        acquisitionStarted();
        return new Promise<Awaited<ReturnType<typeof acquirePublicRepository>>>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("GitHub acquisition cancelled.")), { once: true }));
      } }));
      const job = manager.create(repoUrl);
      await started;
      await vi.advanceTimersByTimeAsync(90_000);
      await manager.wait(job.id);
      expect(manager.get(job.id)).toMatchObject({ phase: "failed", error: "GitHub analysis exceeded its 90-second deadline.", diagnostics: { selectedBlobs: 4, completedBlobs: 1, metadataCommitMs: 4 } });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(await manager.artifact(job.id, "graph.json")).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
  it("fails closed when the isolated scanner is unavailable", async () => {
    const acquire = vi.fn(dependencies().acquire);
    const manager = new GitHubJobManager(dependencies({ available: async () => { throw new Error("Docker sandbox unavailable."); }, acquire }));
    const job = manager.create(repoUrl); await manager.wait(job.id);
    expect(manager.get(job.id)).toMatchObject({ phase: "failed", error: "Docker sandbox unavailable." });
    expect(acquire).not.toHaveBeenCalled();
  });
  it("rejects malformed scanner output without publishing artifacts", async () => {
    const manager = new GitHubJobManager(dependencies({ scan: async () => "{}" }));
    const job = manager.create(repoUrl); await manager.wait(job.id);
    expect(manager.get(job.id)?.phase).toBe("failed");
    expect(await manager.artifact(job.id, "graph.json")).toBeUndefined();
  });
  it("bounds new jobs and expires retained artifacts", async () => {
    let now = Date.now();
    const manager = new GitHubJobManager(dependencies({ now: () => now }));
    for (let i = 0; i < 3; i++) { const job = manager.create(repoUrl); await manager.wait(job.id); }
    expect(() => manager.create(repoUrl)).toThrow(/rate limit/);
    now += 5 * 60_000 + 1;
    const next = manager.create(repoUrl); await manager.wait(next.id);
    expect(manager.get(next.id)?.phase).toBe("ready");
  });
});
