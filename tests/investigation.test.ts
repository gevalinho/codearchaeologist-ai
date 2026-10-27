import { describe, expect, it } from "vitest";
import path from "node:path";
import { investigateFixture } from "../src/lib/agents/investigation-orchestrator";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import type { ModelProvider } from "../src/lib/ai/model-provider";

const fixtureRoot = path.resolve("tests/fixtures/legacy-pricing");
const selected = { paths: ["pricing.js"] };
const loyalty = { id: "loyalty", explanation: "Customers with at least five years receive a 15% discount", preconditions: [{ description: "customerYears >= 5" }], expectedBehavior: { description: "discountPercent becomes 15" }, confidence: 0.9, evidence: [{ path: "pricing.js", startLine: 5, endLine: 5 }] };
const approved = { assessments: [{ id: "loyalty", supported: true, reason: "Line 5 directly sets the discount" }] };
const run = (provider: ModelProvider, maxDurationMs?: number) => investigateFixture({ fixtureId: "legacy-pricing", fixtureRoot, provider, maxDurationMs });

describe("bounded investigation", () => {
  it("runs a complete, explicitly mocked demonstration without verification", async () => {
    const provider = new MockModelProvider([selected, { rules: [loyalty] }, approved]);
    const report = await run(provider);
    expect(report.model).toMatchObject({ provider: "MOCK", model: "fixture-mock", calls: 3 });
    expect(report.rules).toHaveLength(1);
    expect(report.rules[0]).toMatchObject({ id: "loyalty", supportStatus: "SUPPORTED", verificationStatus: "NOT_TESTED" });
    expect(report.rules[0].evidence[0].excerpt).toContain("discountPercent = 15");
    expect(report.investigation.actions.map((a) => a.kind)).toEqual(["INSPECT", "REQUEST_EVIDENCE", "INSPECT", "HYPOTHESIZE", "REQUEST_EVIDENCE", "REPORT"]);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[0].input).not.toContain("discountPercent");
    expect(provider.requests[1].input).toContain("5:   if (customerYears >= 5)");
  });
  it("rejects invented selected file paths before source disclosure", async () => {
    const provider = new MockModelProvider([{ paths: ["../secret.js"] }]);
    await expect(run(provider)).rejects.toMatchObject({ code: "MALFORMED" });
    expect(provider.requests).toHaveLength(1);
  });
  it("rejects invented evidence paths and invalid line ranges", async () => {
    for (const evidence of [{ path: "invented.js", startLine: 5, endLine: 5 }, { path: "pricing.js", startLine: 500, endLine: 500 }]) {
      const report = await run(new MockModelProvider([selected, { rules: [{ ...loyalty, evidence }] }, { assessments: [] }]));
      expect(report.rules).toHaveLength(0);
      expect(report.rejectedHypotheses).toEqual([{ id: "loyalty", reason: expect.stringContaining("invalid") }]);
    }
  });
  it("rejects a contradictory claim after independent source review", async () => {
    const claim = { ...loyalty, explanation: "Long-term customers receive no discount" };
    const report = await run(new MockModelProvider([selected, { rules: [claim] }, { assessments: [{ id: "loyalty", supported: false, reason: "Line 5 assigns a 15% discount" }] }]));
    expect(report.rules).toHaveLength(0);
    expect(report.rejectedHypotheses).toEqual([{ id: "loyalty", reason: "Line 5 assigns a 15% discount" }]);
  });
  it("fails explicitly on malformed model output", async () => {
    await expect(run(new MockModelProvider([selected, { rules: "not an array" }]))).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(run(new MockModelProvider([selected, { rules: [loyalty] }, { assessments: [{ id: "invented", supported: true, reason: "yes" }] }]))).rejects.toMatchObject({ code: "MALFORMED" });
  });
  it("fails explicitly on provider errors", async () => {
    await expect(run(new MockModelProvider([new Error("provider offline")]))).rejects.toMatchObject({ code: "PROVIDER" });
  });
  it("enforces a deadline even when a provider ignores the abort signal", async () => {
    const provider: ModelProvider = { kind: "MOCK", complete: async () => new Promise(() => undefined) };
    await expect(run(provider, 20)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("enforces inspected source size before sending it to the model", async () => {
    const provider = new MockModelProvider([selected, { rules: [loyalty] }, approved]);
    const report = await run(provider);
    expect(report.inventory.files.length).toBe(1);
    expect(provider.requests[1].input.length).toBeLessThan(8_000);
  });
  it("does not accept a model claim of verified execution", async () => {
    const claim = { ...loyalty, verificationStatus: "VERIFIED", verification: { status: "VERIFIED", exitCode: 0 }, test: { id: "fake", source: "throw 1", description: "fake" } };
    const report = await run(new MockModelProvider([selected, { rules: [claim] }, approved]));
    expect(report.rules[0].verificationStatus).toBe("NOT_TESTED");
    expect(report.rules[0].verification).toBeUndefined();
    expect(report.rules[0].test).toBeUndefined();
  });
});
