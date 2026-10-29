import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSession } from "../src/lib/github-ingestion/session";

vi.mock("server-only", () => ({}));
const { user, verify, jobs } = vi.hoisted(() => {
  const user: UserSession = { id: "42", login: "alice", token: "server-only-token", nonce: "a".repeat(43), expiresAt: Date.now() + 60_000 };
  return { user, verify: vi.fn(async (request: Request) => request.headers.get("cookie") === "session=alice" ? user : null), jobs: { createPublic: vi.fn(() => ({ id: "public-job", phase: "validating-repository-url" })), createPrivate: vi.fn(async () => ({ id: "private-job", phase: "validating-repository-url" })), ownedJob: vi.fn(() => true), privateJob: vi.fn(() => false), authorizedStatus: vi.fn(async () => ({ id: "public-job", phase: "ready" })), artifact: vi.fn(async () => "{\"schemaVersion\":\"1.0.0\"}"), cancel: vi.fn(() => ({ id: "public-job", phase: "cancelled" })) } };
});
vi.mock("../src/lib/github-ingestion/production-auth", () => ({ verifiedGitHubSession: verify }));
vi.mock("../src/lib/github-ingestion/jobs", () => ({ githubJobs: jobs }));

import { POST as start } from "../src/app/api/github-jobs/route";
import { GET as status, DELETE as cancel } from "../src/app/api/github-jobs/[id]/route";
import { GET as artifact } from "../src/app/api/github-jobs/[id]/artifacts/[name]/route";

const prior = { ...process.env };
const request = (url: string, method = "GET", body?: unknown, cookie = "session=alice", origin = "https://app.example") => new Request(`https://app.example${url}`, { method, headers: { Origin: origin, Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(() => { process.env.GITHUB_APP_ORIGIN = "https://app.example"; process.env.ENABLE_GITHUB_INGESTION = "1"; vi.clearAllMocks(); });
afterEach(() => { process.env = { ...prior }; });

describe("production GitHub job routes", () => {
  it("requires GitHub authentication and same origin for public and private starts", async () => {
    expect((await start(request("/api/github-jobs", "POST", { url: "https://github.com/example/repo" }, ""))).status).toBe(401);
    expect((await start(request("/api/github-jobs", "POST", { url: "https://github.com/example/repo" }, "session=alice", "https://evil.example"))).status).toBe(403);
    expect(jobs.createPublic).not.toHaveBeenCalled();
    const publicResponse = await start(request("/api/github-jobs", "POST", { url: "https://github.com/example/repo" }));
    expect(publicResponse.status).toBe(202);
    expect(jobs.createPublic).toHaveBeenCalledWith("https://github.com/example/repo", user);
    const privateResponse = await start(new Request("https://app.example/api/github-jobs", { method: "POST", headers: { Origin: "https://app.example", Cookie: "session=alice", "Content-Type": "application/json", "x-codearchaeologist-ingestion": "github-app" }, body: JSON.stringify({ installationId: 7, repositoryId: 11 }) }));
    expect(privateResponse.status).toBe(202);
    expect(jobs.createPrivate).toHaveBeenCalledWith(user, 7, 11);
  });

  it("hides cross-user jobs and artifacts and blocks revoked private permissions", async () => {
    jobs.ownedJob.mockReturnValue(false);
    expect((await status(request("/api/github-jobs/public-job"), { params: Promise.resolve({ id: "public-job" }) })).status).toBe(404);
    expect((await artifact(request("/api/github-jobs/public-job/artifacts/graph.json"), { params: Promise.resolve({ id: "public-job", name: "graph.json" }) })).status).toBe(404);
    expect(jobs.artifact).not.toHaveBeenCalled();
    jobs.ownedJob.mockReturnValue(true);
    jobs.authorizedStatus.mockResolvedValue(undefined as never);
    expect((await cancel(request("/api/github-jobs/private-job", "DELETE"), { params: Promise.resolve({ id: "private-job" }) })).status).toBe(404);
    expect(jobs.cancel).not.toHaveBeenCalled();
  });

  it("returns an owned artifact without a browser access key", async () => {
    const response = await artifact(request("/api/github-jobs/public-job/artifacts/graph.json"), { params: Promise.resolve({ id: "public-job", name: "graph.json" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(jobs.artifact).toHaveBeenCalledWith("public-job", "graph.json", user);
    expect(await response.text()).not.toContain(user.token);
  });

  it("does not create a production scan before the isolated worker handoff exists", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await start(request("/api/github-jobs", "POST", { url: "https://github.com/example/repo" }));
    expect(response.status).toBe(503);
    expect(jobs.createPublic).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
