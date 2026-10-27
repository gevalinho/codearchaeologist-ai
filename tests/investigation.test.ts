import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { investigateFixture } from "../src/lib/agents/investigation-orchestrator";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import { ModelProviderError } from "../src/lib/ai/model-provider";
import { buildOperatorArtifact, formatOperatorDiagnostic } from "../src/lib/demo/operator-workflow";
import { formatUsageSummary } from "../src/lib/demo/usage";
import type { ModelProvider } from "../src/lib/ai/model-provider";

const fixtureRoot = path.resolve("tests/fixtures/legacy-pricing");
let multiRoot: string;
beforeAll(async () => {
  multiRoot = await mkdtemp(path.join(tmpdir(), "codearchaeologist-selection-"));
  await Promise.all([writeFile(path.join(multiRoot, "pricing.js"), "export const price = 1;\n"), writeFile(path.join(multiRoot, "shipping.ts"), "export const shipping = 2;\n")]);
});
afterAll(async () => { await rm(multiRoot, { recursive: true, force: true }); });
const loyalty = { id: "loyalty", explanation: "Customers with at least five years receive a 15% discount", preconditions: [{ description: "customerYears >= 5" }], expectedBehavior: { description: "discountPercent becomes 15" }, confidence: 0.9, evidence: [{ path: "pricing.js", startLine: 5, endLine: 5 }] };
const approved = { assessments: [{ id: "loyalty", supported: true, reason: "Line 5 directly sets the discount" }] };
const run = (provider: ModelProvider, maxDurationMs?: number) => investigateFixture({ fixtureId: "legacy-pricing", fixtureRoot, provider, maxDurationMs });
const runMulti = (provider: ModelProvider) => investigateFixture({ fixtureId: "multi-file", fixtureRoot: multiRoot, provider });

describe("bounded investigation", () => {
  it("runs a complete, explicitly mocked demonstration without verification", async () => {
    const provider = new MockModelProvider([{ rules: [loyalty] }, approved]);
    const report = await run(provider);
    expect(report.model).toMatchObject({ provider: "MOCK", model: "fixture-mock", calls: 2 });
    expect(report.selection).toEqual({ method: "DETERMINISTIC_SINGLE_FILE", paths: ["pricing.js"] });
    expect(report.inventory.files.map((file) => file.path)).toEqual(["pricing.js"]);
    expect(report.rules).toHaveLength(1);
    expect(report.rules[0]).toMatchObject({ id: "loyalty", supportStatus: "SUPPORTED", verificationStatus: "NOT_TESTED" });
    expect(report.rules[0].evidence[0].excerpt).toContain("discountPercent = 15");
    expect(report.investigation.actions.map((a) => a.kind)).toEqual(["INSPECT", "INSPECT", "INSPECT", "HYPOTHESIZE", "REQUEST_EVIDENCE", "REPORT"]);
    expect(report.investigation.actions[1].detail).toContain("Deterministically select");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0].name).toBe("candidate_rules");
    expect(provider.requests.map((request) => [request.name, request.maxOutputTokens])).toEqual([["candidate_rules", 3_000], ["review_rules", 1_500]]);
    expect(provider.requests[0].input).toContain("5:   if (customerYears >= 5)");
  });
  it("rejects empty, duplicate, unknown, and unsafe multi-file selections", async () => {
    for (const paths of [[], ["pricing.js", "pricing.js"], ["unknown.js"], ["../secret.js"], ["/tmp/secret.js"]]) {
      const provider = new MockModelProvider([{ paths }]);
      await expect(runMulti(provider)).rejects.toMatchObject({ code: "MALFORMED", step: "SELECT_FILES", category: "EVIDENCE_VALIDATION" });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0].schema).toMatchObject({ properties: { paths: { items: { enum: ["pricing.js", "shipping.ts"] } } } });
    }
  });
  it("accepts allowlisted selections in a multi-file inventory", async () => {
    const provider = new MockModelProvider([{ paths: ["shipping.ts"] }, { rules: [] }, { assessments: [] }]);
    const report = await runMulti(provider);
    expect(report.selection).toEqual({ method: "MODEL", paths: ["shipping.ts"] });
    expect(report.model?.calls).toBe(3);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests.map((request) => [request.name, request.maxOutputTokens])).toEqual([["select_files", 1_500], ["candidate_rules", 3_000], ["review_rules", 1_500]]);
    expect(provider.requests[1].input).toContain("shipping.ts");
    expect(provider.requests[1].input).not.toContain("price = 1");
  });
  it("rejects invented evidence paths and invalid line ranges", async () => {
    for (const evidence of [{ path: "invented.js", startLine: 5, endLine: 5 }, { path: "pricing.js", startLine: 500, endLine: 500 }]) {
      const report = await run(new MockModelProvider([{ rules: [{ ...loyalty, evidence }] }, { assessments: [] }]));
      expect(report.rules).toHaveLength(0);
      expect(report.rejectedHypotheses).toEqual([{ id: "loyalty", reason: expect.stringContaining("invalid") }]);
    }
  });
  it("rejects a contradictory claim after independent source review", async () => {
    const claim = { ...loyalty, explanation: "Long-term customers receive no discount" };
    const report = await run(new MockModelProvider([{ rules: [claim] }, { assessments: [{ id: "loyalty", supported: false, reason: "Line 5 assigns a 15% discount" }] }]));
    expect(report.rules).toHaveLength(0);
    expect(report.rejectedHypotheses).toEqual([{ id: "loyalty", reason: "Line 5 assigns a 15% discount" }]);
  });
  it("fails explicitly on malformed model output", async () => {
    await expect(run(new MockModelProvider([{ rules: "not an array" }]))).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(run(new MockModelProvider([{ rules: [loyalty] }, { assessments: [{ id: "invented", supported: true, reason: "yes" }] }]))).rejects.toMatchObject({ code: "MALFORMED" });
  });
  it("fails explicitly on provider errors", async () => {
    await expect(run(new MockModelProvider([new Error("provider offline")]))).rejects.toMatchObject({ code: "PROVIDER" });
  });
  it("enforces a deadline even when a provider ignores the abort signal", async () => {
    const provider: ModelProvider = { kind: "MOCK", complete: async () => new Promise(() => undefined) };
    await expect(run(provider, 20)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("enforces inspected source size before sending it to the model", async () => {
    const provider = new MockModelProvider([{ rules: [loyalty] }, approved]);
    const report = await run(provider);
    expect(report.inventory.files.length).toBe(1);
    expect(provider.requests[0].input.length).toBeLessThan(8_000);
  });
  it("reports complete bounded usage and omits unavailable reasoning usage", async () => {
    const mock = new MockModelProvider([{ rules: [loyalty] }, approved]);
    const provider: ModelProvider = { kind: "MOCK", complete: async (request) => {
      const response = await mock.complete(request);
      const candidate = request.name === "candidate_rules";
      return { ...response, usage: { inputTokens: candidate ? 7 : 11, outputTokens: candidate ? 100 : 200 }, diagnostics: { httpStatus: 200, finishReason: "stop", contentPresent: true, contentLength: 2, model: "fixture", latencyMs: 1, reasoningTokens: candidate ? 25 : 75 } };
    } };
    const report = await run(provider);
    expect(report.model).toMatchObject({ calls: 2, inputTokens: 18, outputTokens: 300, reasoningTokens: 100 });
    expect(formatUsageSummary(report.model)).toBe("Model calls: 2\nInput tokens: 18\nOutput tokens: 300\nReasoning tokens: 100\n");
    const withoutReasoning = await run(new MockModelProvider([{ rules: [loyalty] }, approved]));
    expect(withoutReasoning.model?.reasoningTokens).toBeUndefined();
    expect(formatUsageSummary(withoutReasoning.model)).toContain("Reasoning tokens: unavailable");
  });
  it("does not accept a model claim of verified execution", async () => {
    const claim = { ...loyalty, verificationStatus: "VERIFIED", verification: { status: "VERIFIED", exitCode: 0 }, test: { id: "fake", source: "throw 1", description: "fake" } };
    const report = await run(new MockModelProvider([{ rules: [claim] }, approved]));
    expect(report.rules[0].verificationStatus).toBe("NOT_TESTED");
    expect(report.rules[0].verification).toBeUndefined();
    expect(report.rules[0].test).toBeUndefined();
  });
  it("preserves typed provider timeout, incomplete, HTTP, and malformed categories", async () => {
    const failures = [
      { error: new ModelProviderError("TIMEOUT", "sensitive timeout text"), answers: [], step: "CANDIDATE_RULES", category: "PROVIDER_TIMEOUT" },
      { error: new ModelProviderError("INCOMPLETE", "sensitive response text"), answers: [], step: "CANDIDATE_RULES", category: "PROVIDER_INCOMPLETE" },
      { error: new ModelProviderError("HTTP", "sensitive HTTP body", { httpStatus: 429, finishReason: null, contentPresent: false, contentLength: 0, model: "fixture", latencyMs: 1 }), answers: [{ rules: [loyalty] }], step: "REVIEW_RULES", category: "PROVIDER_HTTP", httpStatus: 429 },
      { error: new ModelProviderError("MALFORMED", "sensitive malformed body"), answers: [], step: "CANDIDATE_RULES", category: "PROVIDER_MALFORMED" },
      { error: new ModelProviderError("NETWORK", "sensitive network detail"), answers: [], step: "CANDIDATE_RULES", category: "PROVIDER_NETWORK" },
      { error: new ModelProviderError("CONFIG", "sensitive configuration detail"), answers: [], step: "CANDIDATE_RULES", category: "PROVIDER_CONFIG" },
    ];
    for (const failure of failures) {
      const provider = new MockModelProvider([...failure.answers, failure.error]);
      const caught = await run(provider).catch((error: unknown) => error);
      expect(caught).toMatchObject({ code: "PROVIDER", step: failure.step, category: failure.category, httpStatus: failure.httpStatus });
      expect(JSON.stringify(caught)).not.toContain("sensitive");
    }
  });
  it("classifies local evidence validation and overall deadline without leaking inputs", async () => {
    const inventoryFailure = await investigateFixture({ fixtureId: "legacy-pricing", fixtureRoot: path.resolve("tests/fixtures/missing"), provider: new MockModelProvider([]) }).catch((error: unknown) => error);
    expect(inventoryFailure).toMatchObject({ step: "INVENTORY", category: "EVIDENCE_VALIDATION" });
    const invalid = await runMulti(new MockModelProvider([{ paths: ["../secret.js"] }])).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ code: "MALFORMED", step: "SELECT_FILES", category: "EVIDENCE_VALIDATION" });
    const provider: ModelProvider = { kind: "MOCK", complete: async () => new Promise(() => undefined) };
    const expired = await run(provider, 10).catch((error: unknown) => error);
    expect(expired).toMatchObject({ code: "TIMEOUT", step: "CANDIDATE_RULES", category: "INVESTIGATION_TIMEOUT" });
  });
  it("prints only allowlisted operator diagnostics", async () => {
    const provider: ModelProvider = { kind: "BASETEN", complete: async () => { throw new ModelProviderError("HTTP", "secret-key and raw body", { httpStatus: 503, finishReason: null, contentPresent: false, contentLength: 0, model: "secret-model", latencyMs: 1 }); } };
    const caught = await buildOperatorArtifact(provider, { run: async () => { throw new Error("must not execute"); } }).catch((error: unknown) => error);
    const output = formatOperatorDiagnostic(caught, "CONFIGURATION");
    expect(output).toBe("Failure stage: INVESTIGATION\nInvestigation step: CANDIDATE_RULES\nError category: PROVIDER_HTTP\nHTTP status: 503\n");
    expect(output).not.toContain("secret");
  });
});
