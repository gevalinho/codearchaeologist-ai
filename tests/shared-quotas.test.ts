import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { QuotaExceeded, SqliteQuotaStore } from "../src/lib/github-ingestion/quota-store";
import { BasetenModelProvider } from "../src/lib/ai/baseten-provider";
import { runAutonomousInvestigation } from "../src/lib/architecture/autonomous-investigation";
import type { Graph } from "../src/lib/archaeology/scanner";
import demoGraph from "./fixtures/architecture/demo-graph.json";

vi.mock("server-only", () => ({}));
let root: string, file: string, now: number, first: SqliteQuotaStore, second: SqliteQuotaStore;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codearch-quota-"));
  mkdirSync(path.join(root, "private"), { mode: 0o700 });
  file = path.join(root, "private", "state.sqlite"); now = 1_700_000_000_000;
  first = new SqliteQuotaStore(file, () => now); second = new SqliteQuotaStore(file, () => now);
});
afterEach(() => { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); delete process.env.CODEARCH_AI_DAILY_ATTEMPTS; delete process.env.CODEARCH_AI_DAILY_TOKENS; });
const policy = (subject: string, slot?: string) => ({ scope: "scan_start", subject, limit: 2, windowMs: 3_600_000, ...(slot ? { slot, leaseMs: 90_000 } : {}) });

describe("shared SQLite quotas", () => {
  it("atomically limits starts across independent connections and isolates trusted subjects", async () => {
    const outcomes = await Promise.allSettled([Promise.resolve().then(() => first.reserve(policy("alice"))), Promise.resolve().then(() => second.reserve(policy("alice"))), Promise.resolve().then(() => first.reserve(policy("alice")))]);
    expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(2);
    expect(outcomes.find(item => item.status === "rejected")?.reason).toBeInstanceOf(QuotaExceeded);
    expect(second.reserve(policy("bob"))).toBeUndefined();
  });
  it("enforces global scan and AI slots, releases by lease ID, and expires stale leases after restart", () => {
    const scan = first.reserve(policy("alice", "global_scan"));
    expect(() => second.reserve(policy("bob", "global_scan"))).toThrow(QuotaExceeded);
    first.release(scan);
    expect(second.reserve(policy("bob", "global_scan"))).toBeDefined();
    const ai = first.reserve({ scope: "ai_start", subject: "alice", limit: 6, windowMs: 3_600_000, slot: "global_ai", leaseMs: 30_000 });
    expect(first.renew(ai!, 30_000)).toBe(true);
    expect(second.renew({ id: "wrong", slot: "global_ai" }, 30_000)).toBe(false);
    expect(() => second.reserve({ scope: "ai_start", subject: "bob", limit: 6, windowMs: 3_600_000, slot: "global_ai" })).toThrow(QuotaExceeded);
    now += 31_000;
    expect(second.reserve({ scope: "ai_start", subject: "bob", limit: 6, windowMs: 3_600_000, slot: "global_ai" })).toBeDefined();
    first.release(ai);
    expect(() => first.reserve({ scope: "ai_start", subject: "charlie", limit: 6, windowMs: 3_600_000, slot: "global_ai" })).toThrow(QuotaExceeded);
  });
  it("returns a bounded retry interval and cleans expired records", () => {
    first.reserve({ scope: "oauth_login", subject: "global", limit: 1, windowMs: 900_000 });
    expect(() => second.reserve({ scope: "oauth_login", subject: "global", limit: 1, windowMs: 900_000 })).toThrow(QuotaExceeded);
    now += 900_001;
    second.reserve({ scope: "oauth_login", subject: "global", limit: 1, windowMs: 900_000 });
    now += 86_400_001;
    first.reserve({ scope: "oauth_login", subject: "global", limit: 1, windowMs: 900_000 });
    const db = new DatabaseSync(file);
    try { expect((db.prepare("SELECT COUNT(*) AS count FROM quota_events").get() as { count: number }).count).toBe(1); } finally { db.close(); }
  });
  it("counts every retry as a paid attempt and enforces daily budget", async () => {
    process.env.CODEARCH_AI_DAILY_ATTEMPTS = "2";
    process.env.CODEARCH_AI_DAILY_TOKENS = "10000";
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    const provider = new BasetenModelProvider({ apiKey: "test-key", fetcher, maxRetries: 2, quota: first });
    await expect(provider.complete({ name: "test", instructions: "test", input: "test", schema: {}, maxOutputTokens: 100, signal: new AbortController().signal })).rejects.toBeInstanceOf(QuotaExceeded);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const db = new DatabaseSync(file);
    try { expect((db.prepare("SELECT attempts FROM provider_usage").get() as { attempts: number }).attempts).toBe(2); } finally { db.close(); }
  });
  it("bounds token reservations and resets the budget on the next UTC day", () => {
    process.env.CODEARCH_AI_DAILY_TOKENS = "100";
    first.providerAttempt(60);
    expect(() => second.checkProviderBudget()).not.toThrow();
    expect(() => second.providerAttempt(50)).toThrow(QuotaExceeded);
    first.providerAttempt(40);
    expect(() => second.checkProviderBudget()).toThrow(QuotaExceeded);
    now = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
    expect(() => second.providerAttempt(50)).not.toThrow();
  });
  it("accounts for every autonomous action and final report provider call", async () => {
    const outputs = [
      { tool: "search_components", query: "Login", componentId: "", depth: 0 },
      { tool: "search_components", query: "User", componentId: "", depth: 0 },
      { tool: "check_coverage", query: "", componentId: "", depth: 0 },
      { schemaVersion: "1.0.0", status: "insufficient-evidence", answer: "Insufficient evidence to establish authentication behavior.", evidenceIds: [], uncertainty: "Only analyzed graph metadata was inspected; additional source inspection is needed." },
    ];
    const fetcher = vi.fn(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(outputs.shift()) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    const provider = new BasetenModelProvider({ apiKey: "test-key", fetcher, maxRetries: 0, quota: first });
    await runAutonomousInvestigation(demoGraph as Graph, "public-github", "Inspect authentication", provider, new AbortController().signal, () => undefined);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const db = new DatabaseSync(file);
    try { expect((db.prepare("SELECT attempts FROM provider_usage").get() as { attempts: number }).attempts).toBe(4); } finally { db.close(); }
  });
});
