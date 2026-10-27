import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { inventoryFixture } from "../src/lib/repository/inventory";
import { extractEvidence } from "../src/lib/repository/evidence";
import { PRICING_TEMPLATES } from "../src/lib/verification/pricing-templates";
import { readBoundedReport, reverifySavedArtifact, MAX_SAVED_REPORT_BYTES } from "../src/lib/demo/offline-reverification";
import { serializeDemoArtifact, validateDemoArtifact } from "../src/lib/demo/report-artifact";
import type { InvestigationReport } from "../src/types/investigation";

async function savedArtifact() {
  const inventory = await inventoryFixture("legacy-pricing", path.resolve("tests/fixtures/legacy-pricing"));
  const report: InvestigationReport = {
    investigation: { id: "saved", fixtureId: "legacy-pricing", status: "COMPLETED", startedAt: new Date().toISOString(), actions: [{ step: 1, kind: "VERIFY", detail: "No matching cases", at: new Date().toISOString() }] },
    inventory, selection: { method: "DETERMINISTIC_SINGLE_FILE", paths: ["pricing.js"] },
    summary: "Saved investigation", model: { provider: "BASETEN", model: "meta-models/muse-spark-open-1026", calls: 2, inputTokens: 150, outputTokens: 300, reasoningTokens: 100, latencyMs: 1234 },
    rules: [{ id: "claim", explanation: "subtotalCents must be an integer >= 0 or throws 'Invalid subtotal'", preconditions: [], expectedBehavior: { description: "function enforces validation on subtotalCents input" }, confidence: 0.9, evidence: [extractEvidence(inventory, "pricing.js", 3, 3)], supportStatus: "SUPPORTED", verificationStatus: "NOT_TESTED", verification: { status: "NOT_TESTED", reason: "Rule does not exactly match a trusted pricing template and required source lines" } }],
    limitations: ["Trusted fixture only"],
  };
  return JSON.parse(serializeDemoArtifact(report)) as Record<string, unknown>;
}

describe("operator-only offline re-verification", () => {
  it("runs only reviewed cases and preserves original model usage", async () => {
    const saved = await savedArtifact();
    const runner = { run: vi.fn(async (cases: readonly { id: string; expected: unknown }[]) => ({ kind: "EXECUTED" as const, stdout: JSON.stringify({ observations: cases.map((item) => ({ id: item.id, ...item.expected as object })) }), stderr: "", exitCode: 0, durationMs: 2 })) };
    const result = await reverifySavedArtifact(saved, runner);
    expect(runner.run.mock.calls[0][0]).toEqual(PRICING_TEMPLATES[5].cases);
    expect(result.counts).toEqual({ VERIFIED: 1, FAILED: 0, BLOCKED: 0, NOT_TESTED: 0 });
    const parsed = validateDemoArtifact(JSON.parse(result.artifact));
    expect(parsed.report.model).toEqual((saved.report as InvestigationReport).model);
    expect(parsed.report.investigation.actions.filter((action) => action.kind === "VERIFY")).toHaveLength(1);
    expect((saved.report as InvestigationReport).rules[0].verificationStatus).toBe("NOT_TESTED");
  });
  it("rejects invalid, tampered, unsupported, and previously executed artifacts before Docker", async () => {
    const base = await savedArtifact();
    const runner = { run: vi.fn() };
    const altered = [
      { ...base, execution: "ISOLATED_DOCKER" },
      { ...base, report: { ...(base.report as object), inventory: { ...(base.report as InvestigationReport).inventory, files: [{ ...(base.report as InvestigationReport).inventory.files[0], content: "tampered" }] } } },
    ];
    for (const input of altered) await expect(reverifySavedArtifact(input, runner)).rejects.toThrow();
    for (const change of [
      { supportStatus: "REJECTED" },
      { explanation: "unrelated rule" },
      { verificationStatus: "BLOCKED", verification: { status: "BLOCKED", reason: "Docker unavailable" } },
      { verificationCases: PRICING_TEMPLATES[5].cases },
      { test: { id: "x", description: "untrusted", source: "untrusted code" } },
      { evidence: [{ ...(base.report as InvestigationReport).rules[0].evidence[0], excerpt: "invented" }] },
    ]) {
      const input = structuredClone(base) as { report: InvestigationReport };
      Object.assign(input.report.rules[0], change);
      await expect(reverifySavedArtifact(input, runner)).rejects.toThrow();
    }
    expect(runner.run).not.toHaveBeenCalled();
  });
  it("keeps Docker failures truthful", async () => {
    const saved = await savedArtifact();
    const blocked = await reverifySavedArtifact(saved, { run: async () => ({ kind: "BLOCKED", reason: "Docker unavailable", durationMs: 1 }) });
    expect(blocked.counts).toEqual({ VERIFIED: 0, FAILED: 0, BLOCKED: 1, NOT_TESTED: 0 });
    expect(validateDemoArtifact(JSON.parse(blocked.artifact)).execution).toBe("NOT_EXECUTED");
    const failed = await reverifySavedArtifact(saved, { run: async () => ({ kind: "TIMEOUT", reason: "Container exceeded five-second limit", durationMs: 5000, exitCode: null }) });
    expect(failed.counts.FAILED).toBe(1);
    expect(failed.counts.VERIFIED).toBe(0);
  });
  it("rejects symlinks and oversized saved files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "offline-report-"));
    try {
      const file = path.join(directory, "report.json");
      const link = path.join(directory, "link.json");
      await writeFile(file, JSON.stringify(await savedArtifact()));
      await symlink(file, link);
      await expect(readBoundedReport(link)).rejects.toThrow();
      expect(await readBoundedReport(file)).toMatchObject({ execution: "NOT_EXECUTED" });
      await writeFile(file, "x".repeat(MAX_SAVED_REPORT_BYTES + 1));
      await expect(readBoundedReport(file)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
