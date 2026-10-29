import "server-only";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openStateDatabase } from "./state-db";

export class QuotaExceeded extends Error {
  constructor(readonly retryAfterSeconds: number, readonly rule: string) { super("Shared quota exceeded."); }
}

export type QuotaPolicy = { scope: string; subject: string; limit: number; windowMs: number; slot?: string; leaseMs?: number };
export type QuotaLease = { id: string; slot: string };
const DAY = 86_400_000;
const limitEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) throw new Error(`Invalid ${name} configuration.`);
  return value;
};

export class SqliteQuotaStore {
  private readonly db: DatabaseSync;
  constructor(file: string, private readonly now: () => number = Date.now) { this.db = openStateDatabase(file); }
  close() { this.db.close(); }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try { const result = run(); this.db.exec("COMMIT;"); return result; }
    catch (error) { this.db.exec("ROLLBACK;"); throw error; }
  }
  private sweep(now: number) {
    this.db.prepare("DELETE FROM quota_events WHERE occurred_at <= ?").run(now - DAY);
    this.db.prepare("DELETE FROM quota_leases WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM provider_usage WHERE day < ?").run(Math.floor(now / DAY) - 2);
  }
  reserve(policy: QuotaPolicy): QuotaLease | undefined {
    if (!Number.isSafeInteger(policy.limit) || policy.limit < 1 || !Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1 || !/^[a-z_]{1,40}$/.test(policy.scope) || !policy.subject || policy.subject.length > 128) throw new Error("Invalid quota policy.");
    const now = this.now();
    return this.transaction(() => {
      this.sweep(now);
      if (policy.slot) {
        const existing = this.db.prepare("SELECT expires_at FROM quota_leases WHERE slot = ?").get(policy.slot) as { expires_at: number } | undefined;
        if (existing) throw new QuotaExceeded(Math.max(1, Math.ceil((existing.expires_at - now) / 1000)), `${policy.scope}_active`);
      }
      const first = this.db.prepare("SELECT occurred_at FROM quota_events WHERE scope = ? AND subject = ? AND occurred_at > ? ORDER BY occurred_at LIMIT 1").get(policy.scope, policy.subject, now - policy.windowMs) as { occurred_at: number } | undefined;
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM quota_events WHERE scope = ? AND subject = ? AND occurred_at > ?").get(policy.scope, policy.subject, now - policy.windowMs) as { count: number }).count;
      if (count >= policy.limit) throw new QuotaExceeded(Math.max(1, Math.ceil(((first?.occurred_at ?? now) + policy.windowMs - now) / 1000)), `${policy.scope}_rate`);
      this.db.prepare("INSERT INTO quota_events(scope,subject,occurred_at) VALUES(?,?,?)").run(policy.scope, policy.subject, now);
      if (!policy.slot) return undefined;
      const lease = { id: randomUUID(), slot: policy.slot };
      this.db.prepare("INSERT INTO quota_leases(slot,lease_id,expires_at) VALUES(?,?,?)").run(lease.slot, lease.id, now + (policy.leaseMs ?? 90_000));
      return lease;
    });
  }
  release(lease: QuotaLease | undefined) { if (lease) this.db.prepare("DELETE FROM quota_leases WHERE slot = ? AND lease_id = ?").run(lease.slot, lease.id); }
  renew(lease: QuotaLease, leaseMs: number): boolean {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error("Invalid lease duration.");
    const now = this.now();
    return this.db.prepare("UPDATE quota_leases SET expires_at = ? WHERE slot = ? AND lease_id = ? AND expires_at > ?").run(now + leaseMs, lease.slot, lease.id, now).changes === 1;
  }
  checkProviderBudget(): void {
    const now = this.now(), day = Math.floor(now / DAY);
    this.transaction(() => {
      this.sweep(now);
      const row = this.db.prepare("SELECT attempts,reserved_tokens FROM provider_usage WHERE day = ?").get(day) as { attempts: number; reserved_tokens: number } | undefined;
      if ((row?.attempts ?? 0) >= limitEnv("CODEARCH_AI_DAILY_ATTEMPTS", 40) || (row?.reserved_tokens ?? 0) >= limitEnv("CODEARCH_AI_DAILY_TOKENS", 250_000)) throw new QuotaExceeded(Math.max(1, Math.ceil(((day + 1) * DAY - now) / 1000)), "provider_daily_budget");
    });
  }
  providerAttempt(maxOutputTokens: number): void {
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 100_000) throw new Error("Invalid provider token reservation.");
    const now = this.now(), day = Math.floor(now / DAY);
    this.transaction(() => {
      this.sweep(now);
      const row = this.db.prepare("SELECT attempts,reserved_tokens FROM provider_usage WHERE day = ?").get(day) as { attempts: number; reserved_tokens: number } | undefined;
      const attempts = limitEnv("CODEARCH_AI_DAILY_ATTEMPTS", 40), tokens = limitEnv("CODEARCH_AI_DAILY_TOKENS", 250_000);
      if ((row?.attempts ?? 0) >= attempts || (row?.reserved_tokens ?? 0) + maxOutputTokens > tokens) throw new QuotaExceeded(Math.max(1, Math.ceil(((day + 1) * DAY - now) / 1000)), "provider_daily_budget");
      this.db.prepare("INSERT INTO provider_usage(day,attempts,reserved_tokens,actual_tokens) VALUES(?,1,?,0) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1,reserved_tokens=reserved_tokens+excluded.reserved_tokens").run(day, maxOutputTokens);
    });
  }
  recordTokens(count: number) { if (Number.isSafeInteger(count) && count >= 0) this.db.prepare("UPDATE provider_usage SET actual_tokens = actual_tokens + ? WHERE day = ?").run(count, Math.floor(this.now() / DAY)); }
}

let shared: { file: string; store: SqliteQuotaStore } | undefined;
export function sharedQuotas(): SqliteQuotaStore {
  const file = process.env.CODEARCH_DB_PATH;
  if (!file) throw new Error("Shared quota database is unavailable.");
  if (shared?.file === file) return shared.store;
  shared?.store.close();
  shared = { file, store: new SqliteQuotaStore(file) };
  return shared.store;
}
