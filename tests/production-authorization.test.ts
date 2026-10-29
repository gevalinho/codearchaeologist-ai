import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GitHubHttpFailure } from "../src/lib/github-ingestion/network";
import { createSession, currentSession, nonce, revokeSession, SESSION_COOKIE, type UserSession } from "../src/lib/github-ingestion/session";
import { verifiedGitHubSession } from "../src/lib/github-ingestion/production-auth";
import { GitHubJobManager, type JobDependencies } from "../src/lib/github-ingestion/jobs";
import { authorizedGitHubGraph, authorizedGitHubPacket } from "../src/lib/architecture/ai-artifact-authorization";
import { createRepositoryEvidencePacket } from "../src/lib/architecture/ai-repository-evidence";
import { discoverFeatures } from "../src/lib/architecture/features";
import { createAiInterpretationHandler, allowProductionAi } from "../src/lib/architecture/ai-service";
import { createAutonomousInvestigationHandler } from "../src/lib/architecture/autonomous-service";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import type { Graph } from "../src/lib/archaeology/scanner";
import demoGraph from "./fixtures/architecture/demo-graph.json";

vi.mock("server-only", () => ({}));
const prior = { ...process.env };
let root: string;
const alice = (): UserSession => ({ id: "42", login: "alice", token: "github-token-for-alice", nonce: nonce(), expiresAt: Date.now() + 60_000 });
const bob = (): UserSession => ({ id: "43", login: "bob", token: "github-token-for-bob", nonce: nonce(), expiresAt: Date.now() + 60_000 });
const request = (handle?: string) => new Request("https://app.example/api/test", { headers: handle ? { Cookie: `${SESSION_COOKIE}=${handle}` } : {} });
const repo = "https://github.com/example/repo";
const authorized = { id: 11, owner: "example", name: "repo", private: true, installationId: 7 };
const deps = (allow = true): JobDependencies => ({ available: async () => "sha256:test", acquire: async () => ({ sourceFiles: 2, eligibleFiles: 2, omittedFiles: 0, sourceBytes: 100, skippedFiles: 0, treeEntries: 2, commitSha: "a".repeat(40) }), scan: async () => JSON.stringify(demoGraph), temporary: async () => { const dir = path.join(root, `stage-${randomBytes(4).toString("hex")}`); mkdirSync(dir); return dir; }, cleanup: async dir => rmSync(dir, { recursive: true, force: true }), now: Date.now, authorize: async () => allow ? authorized : null, token: async () => "installation-token-private" });
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-b4-"));
  mkdirSync(path.join(root, "artifacts"), { mode: 0o700 });
  mkdirSync(path.join(root, "staging"), { mode: 0o700 });
  Object.assign(process.env, { CODEARCH_DB_PATH: path.join(root, "state.sqlite"), CODEARCH_ARTIFACT_DIR: path.join(root, "artifacts"), CODEARCH_STAGING_DIR: path.join(root, "staging"), CODEARCH_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), CODEARCH_TOKEN_KEY_VERSION: "1" });
});
afterEach(() => { process.env = { ...prior }; rmSync(root, { recursive: true, force: true }); });

describe("production session and artifact authorization", () => {
  it("requires a durable session and rejects expiry, logout, and revoked GitHub tokens", async () => {
    expect(await verifiedGitHubSession(request(), async () => { throw new Error("no request expected"); })).toBeNull();
    const user = alice(), handle = createSession(user), signed = request(handle);
    const valid = async () => Buffer.from(JSON.stringify({ id: 42, login: "alice" }));
    expect((await verifiedGitHubSession(signed, valid))?.id).toBe("42");
    expect(await verifiedGitHubSession(signed, async () => { throw new GitHubHttpFailure(401); })).toBeNull();
    expect(currentSession(signed)).toBeNull();
    const second = createSession(user), another = request(second);
    revokeSession(another);
    expect(await verifiedGitHubSession(another, valid)).toBeNull();
    const expired = createSession(user), db = new DatabaseSync(process.env.CODEARCH_DB_PATH!);
    try { db.prepare("UPDATE github_sessions SET expires_at = 0").run(); } finally { db.close(); }
    expect(await verifiedGitHubSession(request(expired), valid)).toBeNull();
  });

  it("binds public and private artifacts to the owner's session and current repository permission", async () => {
    const user = alice(), other = bob(), manager = new GitHubJobManager(deps());
    const publicJob = manager.createPublic(repo, user); await manager.wait(publicJob.id);
    expect(manager.ownedJob(publicJob.id, user)).toBe(true);
    expect(manager.ownedJob(publicJob.id, other)).toBe(false);
    expect(await authorizedGitHubGraph(publicJob.id, "public-github", user, manager)).toMatchObject({ snapshotId: demoGraph.snapshotId });
    expect(await authorizedGitHubGraph(publicJob.id, "private-github", user, manager)).toBeNull();
    const graph = await authorizedGitHubGraph(publicJob.id, "public-github", user, manager) as Graph;
    const packet = createRepositoryEvidencePacket(graph, discoverFeatures(graph), "public-github");
    expect(await authorizedGitHubPacket(packet, publicJob.id, user, manager)).toBe(true);
    expect(await authorizedGitHubPacket({ ...packet, limitations: [...packet.limitations, "Invented claim"] }, publicJob.id, user, manager)).toBe(false);
    expect(await authorizedGitHubPacket(packet, publicJob.id, other, manager)).toBe(false);
    const privateJob = await manager.createPrivate(user, 7, 11); await manager.wait(privateJob.id);
    expect(await authorizedGitHubGraph(privateJob.id, "private-github", user, manager)).toBeTruthy();
    expect(await authorizedGitHubGraph(privateJob.id, "private-github", other, manager)).toBeNull();
    expect(await authorizedGitHubGraph(privateJob.id, "public-github", user, manager)).toBeNull();
    const revoked = new GitHubJobManager(deps(false));
    expect(await authorizedGitHubGraph(privateJob.id, "private-github", user, revoked)).toBeNull();
  });

  it("keeps an App-authorized public repository public while rechecking installation access", async () => {
    const user = alice();
    const publicAuthorized = { ...authorized, private: false };
    const manager = new GitHubJobManager({ ...deps(), authorize: async () => publicAuthorized });
    const job = await manager.createPrivate(user, 7, 11); await manager.wait(job.id);
    expect(manager.privateJob(job.id)).toBe(false);
    const graph = await authorizedGitHubGraph(job.id, "public-github", user, manager);
    expect(graph?.githubSource?.visibility).toBe("public");
    expect(await authorizedGitHubGraph(job.id, "private-github", user, manager)).toBeNull();
    const revoked = new GitHubJobManager(deps(false));
    expect(await authorizedGitHubGraph(job.id, "public-github", user, revoked)).toBeNull();
  });

  it("denies forged private evidence before paid calls and permits validated owned evidence", async () => {
    const user = alice(), manager = new GitHubJobManager(deps());
    const job = await manager.createPrivate(user, 7, 11); await manager.wait(job.id);
    const graph = await authorizedGitHubGraph(job.id, "private-github", user, manager) as Graph;
    const packet = createRepositoryEvidencePacket(graph, discoverFeatures(graph), "private-github");
    const answer = { schemaVersion: "1.0.0", status: "insufficient-evidence", answer: "Insufficient evidence to establish repository purpose.", evidenceIds: [], uncertainty: "Static metadata cannot verify runtime behavior." };
    const provider = new MockModelProvider([answer]);
    const handler = createAiInterpretationHandler({ enabled: true, origin: "https://app.example", createProvider: () => provider, privateAuthorized: () => false, authenticate: async () => user, authorizeArtifact: (value, id, identity) => authorizedGitHubPacket(value, id, identity, manager) });
    const call = (body: unknown, origin = "https://app.example") => new Request("https://app.example/api/feature-interpretation", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = { packet, consent: true, question: "What does this do?", history: [], artifactId: job.id };
    expect((await handler(call({ ...payload, consent: false }))).status).toBe(400);
    expect((await handler(call(payload, "https://other.example"))).status).toBe(403);
    expect((await handler(call({ ...payload, artifactId: "not-an-artifact" }))).status).toBe(404);
    expect((await handler(call({ ...payload, packet: { ...packet, origin: "public-github" } }))).status).toBe(404);
    expect(provider.requests).toHaveLength(0);
    const response = await handler(call(payload));
    expect(response.status).toBe(200);
    expect(provider.requests).toHaveLength(1);
    const anonymous = createAiInterpretationHandler({ enabled: true, origin: "https://app.example", createProvider: () => provider, privateAuthorized: () => false, authenticate: async () => null, authorizeArtifact: async () => true });
    expect((await anonymous(call(payload))).status).toBe(401);
  });

  it("rejects forged autonomous graphs before model calls and keeps production opt-in closed by default", async () => {
    expect(allowProductionAi("production", "1", undefined, "https://app.example", "https://app.example")).toBe(false);
    expect(allowProductionAi("production", "1", "1", "https://app.example", "https://app.example")).toBe(true);
    expect(allowProductionAi("production", "1", "1", "http://app.example", "http://app.example")).toBe(false);
    expect(allowProductionAi("production", "1", "1", "https://app.example", "https://other.example")).toBe(false);
    expect(allowProductionAi("development", "1", "1", "https://app.example", "https://app.example")).toBe(false);
    const user = alice(), manager = new GitHubJobManager(deps());
    const job = await manager.createPrivate(user, 7, 11); await manager.wait(job.id);
    const graph = await authorizedGitHubGraph(job.id, "private-github", user, manager) as Graph;
    const provider = new MockModelProvider([]);
    const handler = createAutonomousInvestigationHandler({ enabled: true, origin: "https://app.example", createProvider: () => provider, privateAuthorized: () => false, authenticate: async () => user, resolveGraph: (id, origin, identity) => authorizedGitHubGraph(id, origin, identity, manager) });
    const call = (body: unknown) => new Request("https://app.example/api/autonomous-investigation", { method: "POST", headers: { Origin: "https://app.example", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = { goal: "Inspect authentication", graph, origin: "private-github", consent: true, artifactId: job.id };
    expect((await handler(call({ ...payload, graph: { ...graph, snapshotId: "forged" } }))).status).toBe(404);
    expect((await handler(call({ ...payload, origin: "public-github" }))).status).toBe(404);
    expect((await handler(call({ ...payload, consent: false }))).status).toBe(400);
    expect(provider.requests).toHaveLength(0);
  });
});
