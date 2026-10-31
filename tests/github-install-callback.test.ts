import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({
  connection: vi.fn(async () => {}),
}));

const { installationsForUser } = vi.hoisted(() => ({
  installationsForUser: vi.fn(),
}));

vi.mock("../src/lib/github-ingestion/app", () => ({
  installationsForUser,
}));

import {
  createSession,
  INSTALL_COOKIE,
  nonce,
  seal,
  SESSION_COOKIE,
  type InstallIntent,
  type UserSession,
} from "../src/lib/github-ingestion/session";

import { GET as callback } from "../src/app/api/github-app/install/callback/route";

import { mkdirSync, mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const previousEnv = { ...process.env };
let root: string;

const user: UserSession = {
  id: "42",
  login: "developer",
  token: "test-user-token",
  nonce: nonce(),
  expiresAt: Date.now() + 60 * 60_000,
};

function makeRequest(
  params: Record<string, string>,
  intent?: InstallIntent,
  authenticated = true,
) {
  const url = new URL("https://app.example/api/github-app/install/callback");

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const cookies: string[] = [];

  if (authenticated) {
    cookies.push(`${SESSION_COOKIE}=${createSession(user)}`);
  }

  if (intent) {
    cookies.push(`${INSTALL_COOKIE}=${seal(intent)}`);
  }

  return new Request(url, {
    headers: { Cookie: cookies.join("; ") },
  });
}

function makeIntent(overrides: Partial<InstallIntent> = {}): InstallIntent {
  return {
    state: nonce(),
    userId: user.id,
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-install-test-"));
  mkdirSync(path.join(root, "artifacts"));

  Object.assign(process.env, {
    CODEARCH_DB_PATH: path.join(root, "sessions.sqlite"),
    CODEARCH_ARTIFACT_DIR: path.join(root, "artifacts"),
    CODEARCH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CODEARCH_TOKEN_KEY_VERSION: "1",
    GITHUB_APP_SESSION_SECRET: "s".repeat(32),
  });

  installationsForUser.mockReset();
  installationsForUser.mockResolvedValue([
    { id: 9, account: "developer", accountType: "User" },
  ]);
});

afterEach(() => {
  process.env = { ...previousEnv };
  rmSync(root, { recursive: true, force: true });
});

describe("GitHub installation callback security", () => {
  it("rejects unauthenticated returns", async () => {
    const intent = makeIntent();
    const response = await callback(
      makeRequest({ state: intent.state }, intent, false),
    );
    expect(response.status).toBe(401);
  });

  it("rejects missing installation intents", async () => {
    const response = await callback(makeRequest({ installation_id: "9" }));
    expect(response.status).toBe(401);
  });

  it("rejects expired and cross-user intents", async () => {
    const expired = makeIntent({ expiresAt: Date.now() - 1 });
    expect(
      (await callback(makeRequest({ state: expired.state }, expired))).status,
    ).toBe(401);

    const otherUser = makeIntent({ userId: "another-user" });
    expect(
      (await callback(makeRequest({ state: otherUser.state }, otherUser)))
        .status,
    ).toBe(401);
  });

  it("rejects mismatched state", async () => {
    const intent = makeIntent();
    const response = await callback(makeRequest({ state: nonce() }, intent));
    expect(response.status).toBe(401);
  });

  it("rejects a different installation ID", async () => {
    const intent = makeIntent({ installationId: 9 });
    const response = await callback(
      makeRequest({ installation_id: "10" }, intent),
    );
    expect(response.status).toBe(401);
  });

  it("rejects installations not authorized for the user", async () => {
    installationsForUser.mockResolvedValue([]);
    const intent = makeIntent();
    const response = await callback(
      makeRequest({ state: intent.state, installation_id: "9" }, intent),
    );
    expect(response.status).toBe(401);
  });

  it("accepts a valid state-bound installation return", async () => {
    const intent = makeIntent();
    const response = await callback(
      makeRequest({ state: intent.state, installation_id: "9" }, intent),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      "/?github_connection=updated",
    );
    expect(response.headers.get("Set-Cookie")).toContain(`${INSTALL_COOKIE}=`);
  });

  it("accepts a valid management return without state", async () => {
    const intent = makeIntent({ installationId: 9 });
    const response = await callback(
      makeRequest({ installation_id: "9" }, intent),
    );

    expect(response.status).toBe(303);
  });
});
