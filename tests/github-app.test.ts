import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginLogin,
  finishLogin,
  LoginFailure,
  repositoriesForUser,
  authorizeRepository,
} from "../src/lib/github-ingestion/app";
import {
  cookieHeader,
  createSession,
  currentSession,
  nonce,
  revokeSession,
  seal,
  unseal,
  type UserSession,
} from "../src/lib/github-ingestion/session";
import { acquirePublicRepository } from "../src/lib/github-ingestion/acquire";
import {
  GitHubJobManager,
  type JobDependencies,
} from "../src/lib/github-ingestion/jobs";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import demoGraph from "./fixtures/architecture/demo-graph.json";
import { createHash } from "node:crypto";
import { GET as oauthCallback } from "../src/app/api/github-app/callback/route";
import {
  githubAccept,
  githubRequestHeaders,
  oauthProviderCode,
  oauthTransportCategory,
  OAuthNetworkFailure,
} from "../src/lib/github-ingestion/network";

vi.mock("server-only", () => ({}));
const env = { ...process.env };
const roots: string[] = [];
const user = (id = "1"): UserSession => ({
  id,
  login: `developer${id}`,
  token: `user-token-${id}-long`,
  expiresAt: Date.now() + 60_000,
  nonce: nonce(),
});
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
const repository = {
  id: 42,
  owner: "owner",
  name: "private-repo",
  private: true,
  installationId: 9,
};
beforeEach(() => {
  process.env.GITHUB_APP_ID = "123";
  const root = mkdtempSync(path.join(tmpdir(), "codearch-session-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "artifacts"), { mode: 0o700 });
  Object.assign(process.env, {
    CODEARCH_DB_PATH: path.join(root, "sessions.sqlite"),
    CODEARCH_ARTIFACT_DIR: path.join(root, "artifacts"),
    CODEARCH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CODEARCH_TOKEN_KEY_VERSION: "1",
  });
});
afterEach(async () => {
  process.env = { ...env };
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("GitHub App OAuth and sessions", () => {
  it("builds a state-bound PKCE authorization URL and keeps tokens server-side", async () => {
    Object.assign(process.env, {
      GITHUB_APP_CLIENT_ID: "client",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "codearch",
      GITHUB_APP_ORIGIN: "https://app.example",
      GITHUB_APP_SESSION_SECRET: "s".repeat(32),
    });
    const { url, intent } = beginLogin();
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://github.com");
    expect(parsed.searchParams.get("state")).toBe(intent.state);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(intent.verifier).digest("base64url"),
    );
    const calls: string[] = [];
    const signedIn = await finishLogin(
      "one-time-code",
      intent,
      async (...args) => {
        const [host, requestPath, , , options] = args;
        calls.push(`${host}${requestPath}`);
        if (requestPath.includes("access_token")) {
          expect(options?.method).toBe("POST");
          expect(options?.oauthJson).toBe(true);
          expect(options?.contentType).toBe(
            "application/x-www-form-urlencoded",
          );
          const body = new URLSearchParams(options!.body!);
          expect(Object.fromEntries(body)).toMatchObject({
            client_id: "client",
            code: "one-time-code",
            code_verifier: intent.verifier,
            redirect_uri: "https://app.example/api/github-app/callback",
          });
          return encoded({ access_token: "github-user-token" });
        }
        expect(options?.oauthJson).toBeUndefined();
        return encoded({ id: 7, login: "developer" });
      },
    );
    expect(calls).toEqual([
      "github.com/login/oauth/access_token",
      "api.github.com/user",
    ]);
    const handle = createSession(signedIn),
      request = new Request("https://app.example", {
        headers: { Cookie: `${"codearch_github_session"}=${handle}` },
      });
    expect(handle).not.toContain(signedIn.token);
    expect(currentSession(request)?.id).toBe("7");
    revokeSession(request);
    expect(currentSession(request)).toBeNull();
    expect(cookieHeader("test", "value")).toContain("HttpOnly");
    expect(cookieHeader("test", "value")).toContain("SameSite=Lax");
    const state = seal({ state: intent.state, expiresAt: Date.now() - 1 });
    expect(unseal(state)).toBeTruthy();
  });
  it("rejects expired sessions", () => {
    const expired = { ...user(), expiresAt: Date.now() - 1 };
    const handle = createSession(expired);
    expect(
      currentSession(
        new Request("https://app.example", {
          headers: { Cookie: `codearch_github_session=${handle}` },
        }),
      ),
    ).toBeNull();
  });
  it("rejects OAuth callbacks with missing or mismatched state", async () => {
    process.env.GITHUB_APP_SESSION_SECRET = "s".repeat(32);
    const intent = {
      state: nonce(),
      verifier: nonce(),
      expiresAt: Date.now() + 60_000,
    };
    const cookie = `codearch_github_oauth=${seal(intent)}`;
    const mismatch = new Request(
      "https://app.example/api/github-app/callback?state=wrong&code=abc",
      { headers: { Cookie: cookie } },
    );
    expect((await oauthCallback(mismatch)).status).toBe(401);
    expect(
      (
        await oauthCallback(
          new Request(
            "https://app.example/api/github-app/callback?state=wrong&code=abc",
          ),
        )
      ).status,
    ).toBe(401);
    const expired = new Request(
      `https://app.example/api/github-app/callback?state=${intent.state}&code=abc`,
      {
        headers: {
          Cookie: `codearch_github_oauth=${seal({ ...intent, expiresAt: Date.now() - 1 })}`,
        },
      },
    );
    expect((await oauthCallback(expired)).status).toBe(401);
  });
  it("requests JSON only for the OAuth exchange and classifies legacy form responses safely", async () => {
    Object.assign(process.env, {
      GITHUB_APP_CLIENT_ID: "client",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "codearch",
      GITHUB_APP_ORIGIN: "https://app.example",
    });
    expect(
      githubAccept("github.com", "/login/oauth/access_token", {
        method: "POST",
        oauthJson: true,
      }),
    ).toBe("application/json");
    expect(githubAccept("api.github.com", "/user")).toBe(
      "application/vnd.github+json",
    );
    expect(githubAccept("raw.githubusercontent.com", "/owner/repo/file")).toBe(
      "application/octet-stream",
    );
    expect(() =>
      githubAccept("api.github.com", "/user", { oauthJson: true }),
    ).toThrow(/restricted/);
    const formBody = new URLSearchParams({
      client_secret: "sëcret",
      code: "sample",
    }).toString();
    const headers = githubRequestHeaders(
      "github.com",
      "/login/oauth/access_token",
      {
        method: "POST",
        oauthJson: true,
        contentType: "application/x-www-form-urlencoded",
        body: formBody,
      },
    );
    expect(headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(formBody),
    });
    expect(githubRequestHeaders("api.github.com", "/user").Accept).toBe(
      "application/vnd.github+json",
    );
    const intent = {
      state: nonce(),
      verifier: nonce(),
      expiresAt: Date.now() + 60_000,
    };
    const legacyForm = Buffer.from(
      "access_token=secret-token&token_type=bearer",
    );
    await expect(
      finishLogin("one-time-code", intent, async () => legacyForm),
    ).rejects.toMatchObject({
      stage: "token_response",
    } satisfies Partial<LoginFailure>);
    await expect(
      finishLogin("one-time-code", intent, async (host, requestPath) =>
        requestPath.includes("access_token")
          ? encoded({ access_token: "valid-token-123" })
          : Promise.reject(new Error("network")),
      ),
    ).rejects.toMatchObject({
      stage: "user_lookup",
    } satisfies Partial<LoginFailure>);
    await expect(
      finishLogin("one-time-code", intent, async () =>
        encoded({
          error: "bad_verification_code",
          error_description: "private details",
        }),
      ),
    ).rejects.toMatchObject({
      stage: "token_response",
      category: "provider_error",
      providerCode: "bad_verification_code",
    });
    await expect(
      finishLogin("one-time-code", intent, async () =>
        encoded({ error: "untrusted-provider-value" }),
      ),
    ).rejects.toMatchObject({
      stage: "token_response",
      category: "missing_token",
      providerCode: undefined,
    });
    for (const category of [
      "dns",
      "dns_policy",
      "tls",
      "connection",
      "timeout",
      "redirect",
      "http",
      "response_limit",
      "cancelled",
    ] as const) {
      await expect(
        finishLogin("one-time-code", intent, async () => {
          throw new OAuthNetworkFailure(
            category,
            category === "http" ? 401 : undefined,
          );
        }),
      ).rejects.toMatchObject({
        stage: "token_exchange",
        category,
        httpStatus: category === "http" ? 401 : undefined,
      });
    }
    expect(
      oauthProviderCode(
        encoded({
          error: "bad_verification_code",
          error_description: "never-log-this",
        }),
      ),
    ).toBe("bad_verification_code");
    expect(
      oauthProviderCode(encoded({ error: "attacker-controlled" })),
    ).toBeUndefined();
    expect(oauthTransportCategory("CERT_HAS_EXPIRED")).toBe("tls");
    expect(oauthTransportCategory("ETIMEDOUT")).toBe("timeout");
    expect(oauthTransportCategory("ECONNRESET")).toBe("connection");
  });
});

describe("installation repository authorization", () => {
  const fetch = async (
    _host: string,
    requestPath: string,
    _max: number,
    _signal: AbortSignal,
    options?: { bearer?: string },
  ) => {
    expect(options?.bearer).toBe("user-token-1-long");
    if (requestPath.startsWith("/user/installations?"))
      return encoded({
        total_count: 1,
        installations: [
          {
            id: 9,
            app_id: 123,
            account: { login: "developer1" },
            target_type: "User",
            permissions: { contents: "read" },
            suspended_at: null,
          },
        ],
      });
    return encoded({
      total_count: 1,
      repositories: [
        {
          id: 42,
          owner: { login: "owner" },
          name: "private-repo",
          private: true,
        },
      ],
    });
  };
  it("discovers multiple accessible installations and restricts selection by numeric ID", async () => {
    const repositories = await repositoriesForUser(user(), fetch);
    expect(repositories).toEqual([repository]);
    expect(await authorizeRepository(user(), 9, 42, fetch)).toEqual(repository);
    expect(await authorizeRepository(user(), 9, 43, fetch)).toBeNull();
    expect(await authorizeRepository(user(), 10, 42, fetch)).toBeNull();
  });
  it("fails closed on revoked access and rate limits", async () => {
    expect(
      await repositoriesForUser(user(), async () =>
        encoded({ total_count: 0, installations: [] }),
      ),
    ).toEqual([]);
    await expect(
      repositoriesForUser(user(), async () => {
        throw new Error(
          "GitHub rate limit or access policy blocked this request.",
        );
      }),
    ).rejects.toThrow(/rate limit/);
  });
});

describe("private source acquisition", () => {
  it("uses fixed API blob reads, validates integrity, and keeps the token out of source files", async () => {
    const contents = Buffer.from("<?php class PrivateDemo {}"),
      blob = createHash("sha1")
        .update(`blob ${contents.length}\0`)
        .update(contents)
        .digest("hex");
    const commit = "a".repeat(40),
      tree = "b".repeat(40),
      calls: { host: string; path: string; token?: string }[] = [];
    const root = await mkdtemp(path.join(tmpdir(), "github-private-source-"));
    roots.push(root);
    const result = await acquirePublicRepository(
      {
        owner: "owner",
        repo: "private-repo",
        canonicalUrl: "https://github.com/owner/private-repo",
      },
      path.join(root, "repo"),
      new AbortController().signal,
      async (host, requestPath, _max, _signal, options) => {
        calls.push({ host, path: requestPath, token: options?.bearer });
        if (requestPath === "/repos/owner/private-repo")
          return encoded({
            private: true,
            default_branch: "main",
            size: 250_000,
          });
        if (requestPath.endsWith("/commits/main"))
          return encoded({ sha: commit, commit: { tree: { sha: tree } } });
        if (requestPath.includes("/git/trees/"))
          return encoded({
            sha: tree,
            truncated: false,
            tree: [
              {
                path: "application/controllers/PrivateDemo.php",
                mode: "100644",
                type: "blob",
                size: contents.length,
                sha: blob,
              },
            ],
          });
        if (requestPath.endsWith(`/git/blobs/${blob}`))
          return encoded({
            encoding: "base64",
            content: contents.toString("base64"),
          });
        throw new Error("Unexpected request");
      },
      "installation-token",
    );
    expect(result.sourceFiles).toBe(1);
    expect(result.skippedFiles).toBe(0);
    expect(
      calls.every(
        (call) =>
          call.host === "api.github.com" && call.token === "installation-token",
      ),
    ).toBe(true);
    expect(calls.some((call) => call.path.includes("/git/blobs/"))).toBe(true);
  });
});

describe("private job isolation", () => {
  function deps(overrides: Partial<JobDependencies> = {}): JobDependencies {
    return {
      available: async () => "sha256:test",
      acquire: async () => ({
        sourceFiles: 2,
        eligibleFiles: 2,
        omittedFiles: 0,
        sourceBytes: 220,
        skippedFiles: 6,
        treeEntries: 8,
        commitSha: "a".repeat(40),
      }),
      scan: async () => JSON.stringify(demoGraph),
      temporary: async () => {
        const root = await mkdtemp(path.join(tmpdir(), "github-app-test-"));
        roots.push(root);
        return root;
      },
      cleanup: (root) => rm(root, { recursive: true, force: true }),
      now: Date.now,
      authorize: async () => repository,
      token: async () => "installation-token",
      ...overrides,
    };
  }
  it("binds status, cancellation, and artifacts to one session and live authorization", async () => {
    const alice = user("1"),
      bob = user("2");
    const manager = new GitHubJobManager(deps());
    const job = await manager.createPrivate(alice, 9, 42);
    await manager.wait(job.id);
    expect(manager.get(job.id, bob)).toBeUndefined();
    expect(manager.cancel(job.id, bob)).toBeUndefined();
    expect(await manager.artifact(job.id, "graph.json", bob)).toBeUndefined();
    expect(await manager.artifact(job.id, "graph.json", alice)).toContain(
      "synthetic-architecture-demo",
    );
    expect(manager.get(job.id, { ...alice, nonce: nonce() })).toBeUndefined();
  });
  it("rejects a revoked installation before acquisition", async () => {
    let calls = 0;
    const acquire = vi.fn(deps().acquire);
    const manager = new GitHubJobManager(
      deps({
        authorize: async () => (++calls === 1 ? repository : null),
        acquire,
      }),
    );
    const alice = user();
    const job = await manager.createPrivate(alice, 9, 42);
    await manager.wait(job.id);
    expect(manager.get(job.id, alice)?.phase).toBe("failed");
    expect(acquire).not.toHaveBeenCalled();
  });
  it("uses an installation token for acquisition without passing it to the scanner", async () => {
    const acquire = vi.fn(deps().acquire),
      scan = vi.fn(deps().scan);
    const manager = new GitHubJobManager(deps({ acquire, scan }));
    const job = await manager.createPrivate(user(), 9, 42);
    await manager.wait(job.id);
    expect(acquire.mock.calls[0][4]).toBe("installation-token");
    expect(scan.mock.calls[0].join(" ")).not.toContain("installation-token");
  });
});
