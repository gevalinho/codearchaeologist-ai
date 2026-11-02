"use client";

import { useEffect, useRef, useState } from "react";

export type ScanQuotaStatus = { limit: number; used: number; remaining: number; nextAvailableAt: string | null; serverNow: string };
export const QUOTA_REFRESH_EVENT = "codearchaeologist:quota-refresh";

/** Skew-safe: server clock advanced by client-measured elapsed time since fetch. */
export function quotaRemainingMs(nextAvailableAtMs: number, serverNowMs: number, clientFetchMs: number, clientNowMs: number): number {
  return Math.max(0, nextAvailableAtMs - (serverNowMs + (clientNowMs - clientFetchMs)));
}

export function formatQuotaCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const valid = (value: unknown): value is ScanQuotaStatus => !!value && typeof value === "object" && !Array.isArray(value) &&
  Number.isSafeInteger((value as ScanQuotaStatus).limit) && Number.isSafeInteger((value as ScanQuotaStatus).used) &&
  Number.isSafeInteger((value as ScanQuotaStatus).remaining) && ((value as ScanQuotaStatus).nextAvailableAt === null || typeof (value as ScanQuotaStatus).nextAvailableAt === "string") &&
  typeof (value as ScanQuotaStatus).serverNow === "string" && !Number.isNaN(Date.parse((value as ScanQuotaStatus).serverNow)) &&
  ((value as ScanQuotaStatus).nextAvailableAt === null || !Number.isNaN(Date.parse((value as ScanQuotaStatus).nextAvailableAt as string)));

export function ScanQuotaIndicatorView({ status, remainingMs }: { status: ScanQuotaStatus; remainingMs: number | null }) {
  if (remainingMs === null) return <p className="arch-quota" role="status">Scan allowance: {status.remaining} of {status.limit} available this hour.</p>;
  if (remainingMs <= 0) return <p className="arch-quota" role="status">Scan allowance: checking availability…</p>;
  return <p className="arch-quota arch-quota-exhausted" role="status">Scan allowance used ({status.used} of {status.limit}). Next scan available in {formatQuotaCountdown(remainingMs)}.</p>;
}

export default function ScanQuotaIndicator() {
  const [status, setStatus] = useState<ScanQuotaStatus | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const fetching = useRef(false), refreshedFor = useRef("");
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (fetching.current) return;
      fetching.current = true;
      try {
        const response = await fetch("/api/github-jobs/quota", { cache: "no-store" });
        const body: unknown = await response.json().catch(() => null);
        if (!cancelled && response.ok && valid(body)) { setStatus(body); setFetchedAt(Date.now()); }
      } catch { /* Indicator stays hidden; submission attempts remain allowed. */ }
      finally { fetching.current = false; }
    };
    const onRefresh = () => void load();
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    void load();
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    window.addEventListener(QUOTA_REFRESH_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener(QUOTA_REFRESH_EVENT, onRefresh); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  const exhaustedAt = status && status.remaining <= 0 && status.nextAvailableAt !== null ? Date.parse(status.nextAvailableAt) : null;
  useEffect(() => {
    if (!status || exhaustedAt === null) return;
    const key = `${status.serverNow}:${status.nextAvailableAt}`;
    if (quotaRemainingMs(exhaustedAt, Date.parse(status.serverNow), fetchedAt, Date.now()) <= 0 && refreshedFor.current !== key) {
      refreshedFor.current = key;
      window.dispatchEvent(new Event(QUOTA_REFRESH_EVENT));
    }
  }, [status, exhaustedAt, fetchedAt, now]);
  if (!status) return null;
  if (exhaustedAt === null) return <ScanQuotaIndicatorView status={status} remainingMs={null} />;
  return <ScanQuotaIndicatorView status={status} remainingMs={quotaRemainingMs(exhaustedAt, Date.parse(status.serverNow), fetchedAt, now)} />;
}
