import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UserSession } from "../src/lib/github-ingestion/session";

vi.mock("server-only", () => ({}));
const { user, verify } = vi.hoisted(() => {
  const user: UserSession = { id: "42", login: "alice", token: "server-only-token", nonce: "a".repeat(43), expiresAt: Date.now() + 3_600_000 };
  return { user, verify: vi.fn(async (request: Request) => request.headers.get("cookie") === "session=alice" ? user : null) };
});
vi.mock("../src/lib/github-ingestion/production-auth", () => ({ verifiedGitHubSession: verify }));

import { DatabaseSync } from "node:sqlite";
import { QuotaExceeded, SCAN_START_LIMIT, SCAN_START_WINDOW_MS, SqliteQuotaStore, sharedQuotas } from "../src/lib/github-ingestion/quota-store";
import { GitHubJobManager } from "../src/lib/github-ingestion/jobs";
import { GET as quota } from "../src/app/api/github-jobs/quota/route";
import ScanQuotaIndicator, { ScanQuotaIndicatorView, formatQuotaCountdown, quotaRemainingMs } from "../src/app/architecture/scan-quota-indicator";

let root: string, prior: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-scan-quota-"));
  mkdirSync(path.join(root, "private"), { mode: 0o700 });
  mkdirSync(path.join(root, "artifacts"), { mode: 0o700 });
  prior = { ...process.env };
  process.env.CODEARCH_DB_PATH = path.join(root, "private", "state.sqlite");
  process.env.CODEARCH_ARTIFACT_DIR = path.join(root, "artifacts");
  process.env.GITHUB_APP_ORIGIN = "https://app.example";
  vi.clearAllMocks();
});
afterEach(() => { process.env = { ...prior }; rmSync(root, { recursive: true, force: true }); });

const quotaRequest = (cookie = "session=alice", origin = "https://app.example") => new Request("https://app.example/api/github-jobs/quota", { headers: { Origin: origin, Cookie: cookie } });

describe("scan-start quota status", () => {
  it("uses the raised allowance of 5 starts per rolling hour", () => {
    expect(SCAN_START_LIMIT).toBe(5);
    expect(SCAN_START_WINDOW_MS).toBe(3_600_000);
  });

  it("reports rolling-window usage with the same boundary semantics as enforcement", () => {
    let now = 1_700_000_000_000;
    const store = new SqliteQuotaStore(process.env.CODEARCH_DB_PATH!, () => now);
    try {
      expect(store.scanStartStatus("alice", SCAN_START_LIMIT, SCAN_START_WINDOW_MS)).toEqual({ limit: 5, used: 0, remaining: 5, nextAvailableAt: null, now });
      for (let i = 0; i < 5; i++) { store.reserve({ scope: "scan_start", subject: "alice", limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS }); now += 1_000; }
      const full = store.scanStartStatus("alice", SCAN_START_LIMIT, SCAN_START_WINDOW_MS);
      expect(full).toEqual({ limit: 5, used: 5, remaining: 0, nextAvailableAt: 1_700_000_000_000 + SCAN_START_WINDOW_MS, now });
      expect(() => store.reserve({ scope: "scan_start", subject: "alice", limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS })).toThrow(QuotaExceeded);
      now = 1_700_000_000_000 + SCAN_START_WINDOW_MS;
      expect(store.scanStartStatus("alice", SCAN_START_LIMIT, SCAN_START_WINDOW_MS).used).toBe(4);
      now = 1_700_000_004_000 + SCAN_START_WINDOW_MS;
      expect(store.scanStartStatus("alice", SCAN_START_LIMIT, SCAN_START_WINDOW_MS)).toEqual({ limit: 5, used: 0, remaining: 5, nextAvailableAt: null, now });
      store.reserve({ scope: "scan_start", subject: "alice", limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS });
    } finally { store.close(); }
  });

  it("excludes an event exactly on the window edge from both status and enforcement", () => {
    let now = 1_700_000_000_000;
    const store = new SqliteQuotaStore(process.env.CODEARCH_DB_PATH!, () => now);
    try {
      store.reserve({ scope: "scan_start", subject: "alice", limit: 1, windowMs: SCAN_START_WINDOW_MS });
      expect(() => store.reserve({ scope: "scan_start", subject: "alice", limit: 1, windowMs: SCAN_START_WINDOW_MS })).toThrow(QuotaExceeded);
      now += SCAN_START_WINDOW_MS;
      expect(store.scanStartStatus("alice", 1, SCAN_START_WINDOW_MS).used).toBe(0);
      store.reserve({ scope: "scan_start", subject: "alice", limit: 1, windowMs: SCAN_START_WINDOW_MS });
    } finally { store.close(); }
  });

  it("reads without writing and isolates other subjects and scopes", () => {
    const store = new SqliteQuotaStore(process.env.CODEARCH_DB_PATH!, () => Date.now());
    try {
      store.reserve({ scope: "scan_start", subject: "alice", limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS });
      store.reserve({ scope: "scan_start", subject: "bob", limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS });
      store.reserve({ scope: "ai_start", subject: "alice", limit: 6, windowMs: SCAN_START_WINDOW_MS });
      const db = new DatabaseSync(process.env.CODEARCH_DB_PATH!);
      try {
        const before = (db.prepare("SELECT COUNT(*) AS count FROM quota_events").get() as { count: number }).count;
        expect(store.scanStartStatus("alice", SCAN_START_LIMIT, SCAN_START_WINDOW_MS)).toMatchObject({ used: 1, remaining: 4, nextAvailableAt: null });
        expect((db.prepare("SELECT COUNT(*) AS count FROM quota_events").get() as { count: number }).count).toBe(before);
      } finally { db.close(); }
    } finally { store.close(); }
  });
});

describe("scan-start rejection", () => {
  it("rejects a sixth job start with the rate rule and preserves the active-lease rule", () => {
    const store = new SqliteQuotaStore(process.env.CODEARCH_DB_PATH!, () => Date.now());
    const manager = new GitHubJobManager(undefined, undefined, undefined);
    try {
      for (let i = 0; i < 5; i++) store.reserve({ scope: "scan_start", subject: user.id, limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS });
      try { manager.createPublic("https://github.com/example/repo", user); expect.unreachable(); }
      catch (error) { expect(error).toBeInstanceOf(QuotaExceeded); expect((error as QuotaExceeded).rule).toBe("scan_start_rate"); expect((error as QuotaExceeded).retryAfterSeconds).toBeGreaterThan(0); }
    } finally { store.close(); }
    const leases = new SqliteQuotaStore(process.env.CODEARCH_DB_PATH!, () => Date.now());
    try {
      const other: UserSession = { ...user, id: "99", login: "bob" };
      const lease = leases.reserve({ scope: "scan_start", subject: other.id, limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS, slot: "global_scan", leaseMs: 95_000 });
      try { manager.createPublic("https://github.com/example/other", user); expect.unreachable(); }
      catch (error) { expect(error).toBeInstanceOf(QuotaExceeded); expect((error as QuotaExceeded).rule).toBe("scan_start_active"); }
      finally { leases.release(lease); }
    } finally { leases.close(); }
  });
});

describe("scan quota status route", () => {
  it("requires same origin and GitHub authentication", async () => {
    expect((await quota(quotaRequest("session=alice", "https://evil.example"))).status).toBe(403);
    expect((await quota(quotaRequest(""))).status).toBe(401);
    expect(verify).toHaveBeenCalled();
  });

  it("returns only the authenticated user's allowance without identifiers or secrets", async () => {
    sharedQuotas().reserve({ scope: "scan_start", subject: user.id, limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS });
    sharedQuotas().reserve({ scope: "scan_start", subject: user.id, limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS });
    sharedQuotas().reserve({ scope: "scan_start", subject: "99", limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS });
    const response = await quota(quotaRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["limit", "nextAvailableAt", "remaining", "serverNow", "used"]);
    expect(body).toMatchObject({ limit: 5, used: 2, remaining: 3, nextAvailableAt: null });
    expect(typeof body.serverNow).toBe("string");
    const text = JSON.stringify(body);
    expect(text).not.toContain("alice");
    expect(text).not.toContain(user.token);
  });

  it("reports the next availability timestamp when exhausted", async () => {
    const before = Date.now();
    for (let i = 0; i < 5; i++) sharedQuotas().reserve({ scope: "scan_start", subject: user.id, limit: SCAN_START_LIMIT, windowMs: SCAN_START_WINDOW_MS });
    const body = await (await quota(quotaRequest())).json() as { remaining: number; nextAvailableAt: string; serverNow: string };
    expect(body.remaining).toBe(0);
    const next = Date.parse(body.nextAvailableAt);
    expect(next - before).toBeGreaterThanOrEqual(3_599_000);
    expect(next - before).toBeLessThanOrEqual(3_605_000);
  });
});

describe("scan allowance indicator", () => {
  it("formats countdowns as MM:SS with ceiling seconds", () => {
    expect(formatQuotaCountdown(0)).toBe("00:00");
    expect(formatQuotaCountdown(-500)).toBe("00:00");
    expect(formatQuotaCountdown(1)).toBe("00:01");
    expect(formatQuotaCountdown(61_000)).toBe("01:01");
    expect(formatQuotaCountdown(3_599_000)).toBe("59:59");
    expect(formatQuotaCountdown(3_600_000)).toBe("60:00");
  });

  it("computes remaining time from server timestamps without trusting the client clock", () => {
    const serverNow = 1_700_000_000_000, next = serverNow + 120_000, fetchAt = 1_700_000_005_000;
    expect(quotaRemainingMs(next, serverNow, fetchAt, fetchAt + 30_000)).toBe(90_000);
    expect(quotaRemainingMs(next, serverNow, fetchAt, fetchAt + 120_000)).toBe(0);
    expect(quotaRemainingMs(next, serverNow, fetchAt, fetchAt + 500_000)).toBe(0);
  });

  it("renders allowance, countdown, and checking states without blocking content", () => {
    const status = { limit: 5, used: 2, remaining: 3, nextAvailableAt: null, serverNow: new Date().toISOString() };
    const open = renderToStaticMarkup(createElement(ScanQuotaIndicatorView, { status, remainingMs: null }));
    expect(open).toContain("3 of 5");
    expect(open).toContain('role="status"');
    const exhausted = renderToStaticMarkup(createElement(ScanQuotaIndicatorView, { status: { ...status, used: 5, remaining: 0, nextAvailableAt: new Date(Date.now() + 90_000).toISOString() }, remainingMs: 90_000 }));
    expect(exhausted).toContain("01:30");
    expect(exhausted).toContain("Scan allowance used");
    const checking = renderToStaticMarkup(createElement(ScanQuotaIndicatorView, { status, remainingMs: 0 }));
    expect(checking).toContain("checking availability");
    expect(renderToStaticMarkup(createElement(ScanQuotaIndicator))).toBe("");
  });
});
