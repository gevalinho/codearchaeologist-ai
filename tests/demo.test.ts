import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { handleInvestigationRequest } from "../src/lib/demo/investigation-api";
import { STATUS_LABEL, statusTone } from "../src/lib/demo/status";
import { serializeDemoArtifact, validateDemoArtifact } from "../src/lib/demo/report-artifact";
import { boundedUsage, formatUsageSummary } from "../src/lib/demo/usage";
import { buildOperatorArtifact, OperatorWorkflowError } from "../src/lib/demo/operator-workflow";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import type { ModelProvider } from "../src/lib/ai/model-provider";
import type { SandboxRunner } from "../src/lib/verification/docker-sandbox";
import { inventoryFixture } from "../src/lib/repository/inventory";
import { extractEvidence } from "../src/lib/repository/evidence";
import { PRICING_TEMPLATES } from "../src/lib/verification/pricing-templates";
import type { InvestigationReport } from "../src/types/investigation";

const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://localhost/api/investigate", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const dependencies = () => ({ enabled: true, createProvider: vi.fn(() => ({ kind: "BASETEN" as const, complete: vi.fn() })), investigate: vi.fn(async () => ({ summary: "done" } as InvestigationReport)) });

describe("narrow investigation API", () => {
  it("accepts only the fixed fixture and never calls Docker", async () => {
    const deps = dependencies();
    for (const body of [{ fixtureId: "other" }, { fixtureId: "legacy-pricing", path: "/tmp" }, { fixtureId: "legacy-pricing", command: "docker run" }, { fixtureId: "legacy-pricing", source: "code" }]) {
      const response = await handleInvestigationRequest(request(body), deps);
      expect(response.status).toBe(400);
    }
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(deps.investigate).not.toHaveBeenCalled();
  });
  it("rejects disabled, cross-origin, and oversized requests", async () => {
    const deps = dependencies();
    expect((await handleInvestigationRequest(request({ fixtureId: "legacy-pricing" }), { ...deps, enabled: false })).status).toBe(403);
    expect((await handleInvestigationRequest(request({ fixtureId: "legacy-pricing" }, { Origin: "https://other.example" }), deps)).status).toBe(403);
    expect((await handleInvestigationRequest(request({ fixtureId: "legacy-pricing", extra: "x".repeat(200) }), deps)).status).toBe(413);
  });
  it("returns sanitized provider errors without fallback", async () => {
    const deps = dependencies();
    deps.createProvider.mockImplementation(() => { throw new Error("SECRET_TOKEN provider unavailable"); });
    const response = await handleInvestigationRequest(request({ fixtureId: "legacy-pricing" }), deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET_TOKEN");
    expect(deps.investigate).not.toHaveBeenCalled();
  });
});

async function report(): Promise<InvestigationReport> {
  const inventory = await inventoryFixture("legacy-pricing", path.resolve("tests/fixtures/legacy-pricing"));
  const template = PRICING_TEMPLATES[0];
  const evidence = extractEvidence(inventory, "pricing.js", 5, 5);
  return { investigation: { id: "demo", fixtureId: "legacy-pricing", status: "COMPLETED", startedAt: new Date().toISOString(), actions: [{ step: 1, kind: "VERIFY", detail: "Verified", at: new Date().toISOString() }] }, inventory, selection: { method: "DETERMINISTIC_SINGLE_FILE", paths: ["pricing.js"] }, summary: "One finding", rules: [{ id: template.id, explanation: template.explanation, preconditions: [{ description: template.precondition }], expectedBehavior: { description: template.outcome }, evidence: [evidence], confidence: .9, supportStatus: "SUPPORTED", verificationStatus: "VERIFIED", verification: { status: "VERIFIED", cases: template.cases.map((item) => ({ id: item.id, input: item.input, expected: item.expected, observed: item.expected, passed: true })), output: "raw runner output" } }], model: { provider: "BASETEN", model: "meta-models/muse-spark-open-1026", calls: 2, latencyMs: 500 }, limitations: ["Only the trusted fixture"] };
}

describe("operator artifact", () => {
  it("keeps operator CLI output fixed and accepts no path or command arguments", async () => {
    const cli = await readFile(path.resolve("scripts/generate-demo-report.ts"), "utf8");
    expect(cli).toContain("const provider = createLiveModelProvider()");
    expect(cli).toContain("buildOperatorArtifact(provider, new DockerPricingSandbox())");
    expect(cli).toContain("formatOperatorDiagnostic(error, stage)");
    expect(cli).toContain("process.stderr.write(\"Operator report generation failed.");
    expect(cli).not.toContain("process.argv");
    expect(cli).not.toContain("console.error(error)");
  });
  it("serializes and validates trusted execution without raw output", async () => {
    const serialized = serializeDemoArtifact(await report());
    expect(serialized).not.toContain("raw runner output");
    expect(serialized).not.toContain("BASETEN_API_KEY");
    expect(validateDemoArtifact(JSON.parse(serialized)).execution).toBe("ISOLATED_DOCKER");
  });
  it("rejects forged success, invented evidence, and mock provenance", async () => {
    const base = JSON.parse(serializeDemoArtifact(await report()));
    const altered = structuredClone(base);
    altered.report.rules[0].verification.cases[0].observed.value = 999;
    expect(() => validateDemoArtifact(altered)).toThrow();
    const invented = structuredClone(base);
    invented.report.rules[0].evidence[0].path = "invented.js";
    expect(() => validateDemoArtifact(invented)).toThrow();
    const mocked = structuredClone(base);
    mocked.report.model.provider = "MOCK";
    expect(() => validateDemoArtifact(mocked)).toThrow();
  });
  it("maps all dashboard statuses distinctly", () => {
    const statuses = ["VERIFIED", "FAILED", "BLOCKED", "NOT_TESTED"] as const;
    expect(new Set(statuses.map(statusTone)).size).toBe(4);
    expect(STATUS_LABEL.VERIFIED).toContain("execution");
    expect(STATUS_LABEL.NOT_TESTED).toBe("Not executed");
  });
  it("rejects unsafe artifact usage counts and never formats them as measurements", async () => {
    const base = JSON.parse(serializeDemoArtifact(await report()));
    base.report.model.reasoningTokens = 3_000_001;
    expect(() => validateDemoArtifact(base)).toThrow();
    expect(boundedUsage(-1)).toBe("unavailable");
    expect(boundedUsage(3_000_001)).toBe("unavailable");
    expect(formatUsageSummary(undefined)).toContain("Output tokens: unavailable");
  });
});

function providerFor(explanation: string): ModelProvider {
  const template = PRICING_TEMPLATES[0];
  const mock = new MockModelProvider([
    { rules: [{ id: template.id, explanation, preconditions: [{ description: template.precondition }], expectedBehavior: { description: template.outcome }, confidence: .9, evidence: [{ path: "pricing.js", startLine: 5, endLine: 5 }] }] },
    { assessments: [{ id: template.id, supported: true, reason: "Cited line supports the claim" }] },
  ], "fixture-model");
  // The wire implementation is deterministic; the provider identity matches the live artifact contract.
  return { kind: "BASETEN", complete: (request) => mock.complete(request) };
}

describe("complete operator pipeline with deterministic dependencies", () => {
  it("preserves NOT_TESTED when source-supported model wording misses templates", async () => {
    const runner = { run: vi.fn() };
    const { report, artifact } = await buildOperatorArtifact(providerFor("Five-year customers receive a loyalty reduction"), runner);
    expect(report.rules[0].verificationStatus).toBe("NOT_TESTED");
    expect(runner.run).not.toHaveBeenCalled();
    expect(validateDemoArtifact(JSON.parse(artifact)).execution).toBe("NOT_EXECUTED");
  });
  it("preserves BLOCKED when the isolated runner is unavailable", async () => {
    const runner: SandboxRunner = { run: async () => ({ kind: "BLOCKED", reason: "Docker unavailable", durationMs: 1 }) };
    const { report, artifact } = await buildOperatorArtifact(providerFor(PRICING_TEMPLATES[0].explanation), runner);
    expect(report.rules[0].verificationStatus).toBe("BLOCKED");
    expect(validateDemoArtifact(JSON.parse(artifact)).execution).toBe("NOT_EXECUTED");
  });
  it("round-trips verified observations and exact source evidence", async () => {
    const runner: SandboxRunner = { run: async (cases) => ({ kind: "EXECUTED", stdout: JSON.stringify({ observations: cases.map((item) => ({ id: item.id, ...item.expected })) }), stderr: "", exitCode: 0, durationMs: 1 }) };
    const { report, artifact } = await buildOperatorArtifact(providerFor(PRICING_TEMPLATES[0].explanation), runner);
    expect(report.rules[0].verificationStatus).toBe("VERIFIED");
    const parsed = validateDemoArtifact(JSON.parse(artifact));
    expect(parsed.execution).toBe("ISOLATED_DOCKER");
    expect(parsed.report.rules[0].verification?.cases).toHaveLength(2);
    expect(parsed.report.rules[0].evidence[0].excerpt).toContain("discountPercent = 15");
  });
  it("identifies a provider failure as INVESTIGATION without exposing its message", async () => {
    const provider: ModelProvider = { kind: "BASETEN", complete: async () => { throw new Error("secret provider response"); } };
    await expect(buildOperatorArtifact(provider, { run: vi.fn() })).rejects.toMatchObject({ stage: "INVESTIGATION", message: "Operator workflow failed" });
    expect(new OperatorWorkflowError("VERIFICATION").message).not.toContain("secret");
  });
  it("separates verification failure from artifact validation failure", async () => {
    await expect(buildOperatorArtifact(providerFor(PRICING_TEMPLATES[0].explanation), { run: async () => { throw new Error("private Docker detail"); } })).rejects.toMatchObject({ stage: "VERIFICATION", message: "Operator workflow failed" });
    const template = PRICING_TEMPLATES[0];
    const mock = new MockModelProvider([
      { rules: [{ id: template.id, explanation: template.explanation, preconditions: [{ description: template.precondition }], expectedBehavior: { description: template.outcome }, confidence: .9, evidence: [{ path: "pricing.js", startLine: 5, endLine: 5 }] }] },
      { assessments: [{ id: template.id, supported: true, reason: "Supported" }] },
    ]);
    await expect(buildOperatorArtifact(mock, { run: async () => ({ kind: "BLOCKED", reason: "Docker unavailable", durationMs: 1 }) })).rejects.toMatchObject({ stage: "ARTIFACT_VALIDATION", message: "Operator workflow failed" });
  });
});
