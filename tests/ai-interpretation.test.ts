import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Graph } from "../src/lib/archaeology/scanner";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import { ModelProviderError } from "../src/lib/ai/model-provider";
import { createEvidencePacket, parseEvidencePacket, type EvidenceOrigin } from "../src/lib/architecture/ai-evidence";
import { parseAiInterpretation, parseAiResponseEnvelope } from "../src/lib/architecture/ai-interpretation";
import { parseChatAnswer, parseChatHistory } from "../src/lib/architecture/ai-chat";
import { allowDevelopmentAi, createAiInterpretationHandler, interpretationOutputTokens } from "../src/lib/architecture/ai-service";
import { investigateFeature, studentPromotionFeature } from "../src/lib/architecture/features";
import { planReconstruction } from "../src/lib/architecture/reconstruction-planner";
import { createModernizationPreview } from "../src/lib/architecture/preview";
import { buildModernizationBlueprint } from "../src/lib/architecture/blueprint";
import ReconstructionRenderer from "../src/app/architecture/reconstruction-renderer";
import demoGraph from "./fixtures/architecture/demo-graph.json";

const path = "application/controllers/OrderController.php";
const ref = { path, startLine: 4, endLine: 4 };
const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "snapshot-ai", scan: { fileCount: 1, totalBytes: 100 }, nodes: [
  { id: "order", kind: "controller", name: "OrderController", domain: "unknown", certainty: "observed", method: "fixture", source: ref },
  { id: "endpoint", kind: "endpoint", name: "/orders", domain: "unknown", certainty: "observed", method: "fixture", source: ref },
], edges: [{ id: "call", from: "order", to: "endpoint", kind: "calls-endpoint", source: ref, certainty: "observed", method: "fixture" }], rules: [{ id: "rule-order", kind: "validation", description: "Validates input in a conditional branch.", ownerNodeId: "order", source: ref, certainty: "observed", method: "deterministic-rule-pattern-v1" }], warnings: [], limitations: [] };
const feature = investigateFeature(graph, { term: "order" });
const plan = planReconstruction(graph, feature);
const packet = (origin: EvidenceOrigin = "browser-local") => createEvidencePacket(graph, feature, plan, origin);
const valid = (evidenceId: string) => ({ schemaVersion: "1.0.0", purpose: { text: "An order review may be involved.", evidenceIds: [evidenceId] }, actors: [], steps: [], businessRules: [], dataFlows: [], dependencies: [], modernization: [{ text: "Consider a review boundary.", evidenceIds: [evidenceId] }], openQuestions: [{ text: "What does the method body enforce?", evidenceIds: [] }], uncertainty: ["Source bodies and runtime behavior are unavailable."] });
const key = "x".repeat(40);
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://app.example/api/feature-interpretation", { method: "POST", headers: { Origin: "https://app.example", "Content-Type": "application/json", "x-codearchaeologist-ai-access-key": key, ...headers }, body: JSON.stringify(body) });
const handler = (provider: MockModelProvider, privateAuthorized = false, accessKey = key, maxOutputTokens?: string) => createAiInterpretationHandler({ enabled: true, origin: "https://app.example", accessKey, maxOutputTokens, createProvider: () => provider, privateAuthorized: () => privateAuthorized, now: () => 20_000 });

describe("evidence-grounded interpretation", () => {
  it("constructs a deterministic, versioned, references-only packet for local and private sources", () => {
    const local = packet();
    expect(packet()).toEqual(local);
    expect(local.items.map(item => item.kind)).toEqual(["component", "component", "relationship", "rule"]);
    expect(local.sourceAvailability).toBe("references-only");
    expect(local.excerpts).toEqual([]);
    expect(local.deterministicProposal?.fields).toContain("Synthetic record label");
    expect(packet("private-github").origin).toBe("private-github");
    expect(packet("imported-graph").origin).toBe("imported-graph");
    expect(() => parseEvidencePacket({ ...local, excerpts: ["secret"] })).toThrow();
  });

  it("rejects missing, fabricated, or free-text source citations", () => {
    const evidence = packet();
    const output = valid(evidence.items[0].id);
    expect(parseAiInterpretation(output, evidence)).toEqual(output);
    expect(() => parseAiInterpretation({ ...output, purpose: { text: "Unsupported", evidenceIds: [] } }, evidence)).toThrow();
    expect(() => parseAiInterpretation(valid("invented"), evidence)).toThrow();
    expect(() => parseAiInterpretation({ ...output, purpose: { text: "See invented.php:999", evidenceIds: [evidence.items[0].id] } }, evidence)).toThrow();
    expect(() => parseAiInterpretation({ ...output, uncertainty: [] }, evidence)).toThrow();
    expect(() => parseAiResponseEnvelope({ featureId: "feature:other", snapshotId: evidence.snapshotId, interpretation: output }, evidence)).toThrow(/different feature/);
  });

  it("fails safely on provider errors, malformed output, and missing configuration", async () => {
    const evidence = packet();
    const failed = await handler(new MockModelProvider([new Error("provider secret")]))(request({ packet: evidence, consent: true }));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("provider secret");
    expect((await handler(new MockModelProvider([{}]))(request({ packet: evidence, consent: true }))).status).toBe(503);
    expect((await handler(new MockModelProvider([]), false, "")(request({ packet: evidence, consent: true }))).status).toBe(503);
  });

  it("uses a bounded configurable output budget without changing response validation", async () => {
    expect(interpretationOutputTokens()).toBe(3_000);
    expect(interpretationOutputTokens("3500")).toBe(3_500);
    for (const invalid of ["", "0", "511", "4001", "3000.5", "invalid"]) expect(() => interpretationOutputTokens(invalid)).toThrow();
    const evidence = packet();
    const provider = new MockModelProvider([valid(evidence.items[0].id)]);
    expect((await handler(provider)(request({ packet: evidence, consent: true }))).status).toBe(200);
    expect(provider.requests[0].maxOutputTokens).toBe(3_000);
    const configured = new MockModelProvider([valid(evidence.items[0].id)]);
    expect((await handler(configured, false, key, "3500")(request({ packet: evidence, consent: true }))).status).toBe(200);
    expect(configured.requests[0].maxOutputTokens).toBe(3_500);
    const rejected = new MockModelProvider([valid(evidence.items[0].id)]);
    const response = await handler(rejected, false, key, "5000")(request({ packet: evidence, consent: true }));
    expect((await response.json()).diagnostic.category).toBe("provider_config");
    expect(rejected.requests).toHaveLength(0);
  });

  it("distinguishes upstream HTTP failures, incomplete output, and local validation without leaking content", async () => {
    const evidence = packet();
    const http = await handler(new MockModelProvider([new ModelProviderError("HTTP", "untrusted provider text", { httpStatus: 503, finishReason: null, contentPresent: false, contentLength: 0, model: "fixture", latencyMs: 3 })]))(request({ packet: evidence, consent: true }));
    expect(http.status).toBe(503);
    expect(await http.json()).toMatchObject({ diagnostic: { category: "provider_http", upstreamStatus: 503 } });
    const incomplete = await handler(new MockModelProvider([new ModelProviderError("INCOMPLETE", "secret response", { httpStatus: 200, finishReason: "length", contentPresent: true, contentLength: 10, model: "fixture", latencyMs: 3 })]))(request({ packet: evidence, consent: true }));
    expect(await incomplete.json()).toMatchObject({ diagnostic: { category: "provider_incomplete", finishReason: "length" } });
    const invalid = await handler(new MockModelProvider([{ schemaVersion: "1.0.0", purpose: { text: "invented", evidenceIds: ["fabricated"] } }]))(request({ packet: evidence, consent: true }));
    const body = await invalid.json();
    expect(body.diagnostic).toEqual({ category: "invalid_interpretation" });
    expect(JSON.stringify(body)).not.toMatch(/untrusted provider text|secret response|fabricated/);
  });

  it("requires consent and an authorized private session before provider invocation", async () => {
    const evidence = packet("private-github");
    const provider = new MockModelProvider([valid(evidence.items[0].id)]);
    const handle = handler(provider);
    expect((await handle(request({ packet: evidence, consent: false }))).status).toBe(400);
    expect((await handle(request({ packet: evidence, consent: true }))).status).toBe(401);
    expect(provider.requests).toHaveLength(0);
    const permitted = await handler(provider, true)(request({ packet: evidence, consent: true }));
    expect(permitted.status).toBe(200);
    expect(provider.requests).toHaveLength(1);
  });

  it("rejects wrong origins, missing access keys, oversized bodies, and repeat calls", async () => {
    const evidence = packet();
    const provider = new MockModelProvider([valid(evidence.items[0].id)]);
    const handle = handler(provider);
    expect((await handle(request({ packet: evidence, consent: true }, { Origin: "https://other.example" }))).status).toBe(403);
    expect((await handle(request({ packet: evidence, consent: true }, { "x-codearchaeologist-ai-access-key": "wrong" }))).status).toBe(401);
    expect((await handle(request({ packet: evidence, consent: true }, { "Content-Length": "21000" }))).status).toBe(413);
    expect((await handle(request({ packet: evidence, consent: true }))).status).toBe(200);
    expect((await handle(request({ packet: evidence, consent: true }))).status).toBe(429);
    expect(provider.requests).toHaveLength(1);
  });

  it("keeps browser-local data in the bounded packet and returns cited structured output", async () => {
    const evidence = packet();
    const provider = new MockModelProvider([valid(evidence.items[0].id)]);
    const response = await handler(provider)(request({ packet: evidence, consent: true }));
    expect(response.status).toBe(200);
    expect((await response.json()).featureId).toBe(feature.id);
    expect(JSON.parse(provider.requests[0].input)).toEqual(evidence);
    expect(provider.requests[0].input).not.toContain("sourceBody");
  });

  it("preserves Student Promotion and generic synthetic preview artifacts", () => {
    const promotion = studentPromotionFeature(demoGraph as Graph);
    const blueprint = buildModernizationBlueprint(promotion, demoGraph.snapshotId);
    expect(createModernizationPreview(promotion, blueprint)).not.toBeNull();
    if (plan.status !== "available") throw new Error("Expected generic reconstruction");
    expect(renderToStaticMarkup(createElement(ReconstructionRenderer, { specification: plan.spec }))).toContain("SYNTHETIC PROPOSAL");
  });

  it("accepts development access without a browser secret and validates cited chat answers", async () => {
    const evidence = packet();
    const answer = { schemaVersion: "1.0.0", answer: "A validation pattern was observed.", evidenceIds: [evidence.items[0].id], uncertainty: "The actual method body was not reviewed." };
    const provider = new MockModelProvider([answer]);
    const handle = createAiInterpretationHandler({ enabled: true, origin: "https://app.example", developmentAccess: true, createProvider: () => provider, privateAuthorized: () => false, now: () => 20_000 });
    const response = await handle(request({ packet: evidence, consent: true, question: "Which rules are present?", history: [] }, { "x-codearchaeologist-ai-access-key": "" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ featureId: evidence.featureId, snapshotId: evidence.snapshotId, answer });
    expect(provider.requests[0].maxOutputTokens).toBe(3000);
    expect(() => parseChatAnswer({ ...answer, evidenceIds: ["invented"] }, evidence)).toThrow();
    expect(() => parseChatAnswer({ ...answer, evidenceIds: [] }, evidence)).toThrow();
    expect(() => parseChatAnswer({ ...answer, answer: "Insufficient evidence to determine this.", evidenceIds: [] }, evidence)).not.toThrow();
  });

  it("rejects malformed chat history and keeps an unconfigured deployment closed", async () => {
    expect(allowDevelopmentAi("development", "1", "http://localhost:3000")).toBe(true);
    expect(allowDevelopmentAi("production", "1", "http://localhost:3000")).toBe(false);
    expect(allowDevelopmentAi("development", "1", "https://app.example")).toBe(false);
    expect(allowDevelopmentAi("development", undefined, "http://localhost:3000")).toBe(false);
    const evidence = packet();
    expect(() => parseChatHistory([{ role: "assistant", text: "from another feature", evidenceIds: [] }], evidence)).toThrow();
    expect(() => parseChatHistory([{ role: "user", text: "unfinished" }], evidence)).toThrow();
    expect(() => parseChatHistory([{ role: "user", text: "Question" }, { role: "assistant", text: "Claim", evidenceIds: ["invented"] }], evidence)).toThrow();
    const provider = new MockModelProvider([]);
    const closed = createAiInterpretationHandler({ enabled: false, origin: "https://app.example", createProvider: () => provider, privateAuthorized: () => false });
    expect((await closed(request({ packet: evidence, consent: true }))).status).toBe(503);
    expect(provider.requests).toHaveLength(0);
  });

  it("fails closed on incomplete chat generations and invalid citations", async () => {
    const evidence = packet();
    const input = request({ packet: evidence, consent: true, question: "What is supported?", history: [] }, { "x-codearchaeologist-ai-access-key": "" });
    const incomplete = new MockModelProvider([new ModelProviderError("INCOMPLETE", "untrusted partial response", { httpStatus: 200, finishReason: "length", contentPresent: true, contentLength: 4, model: "fixture", latencyMs: 2, outputTokens: 3000, reasoningTokens: 2800 })]);
    const deps = { enabled: true, origin: "https://app.example", developmentAccess: true, privateAuthorized: () => false, now: () => 20_000 };
    const failure = await createAiInterpretationHandler({ ...deps, createProvider: () => incomplete })(input);
    expect(failure.status).toBe(503);
    expect(await failure.json()).toMatchObject({ diagnostic: { category: "provider_incomplete", finishReason: "length", outputTokens: 3000, reasoningTokens: 2800 } });
    const invalid = new MockModelProvider([{ schemaVersion: "1.0.0", answer: "Unsupported claim", evidenceIds: ["invented"], uncertainty: "Unknown." }]);
    const response = await createAiInterpretationHandler({ ...deps, createProvider: () => invalid })(request({ packet: evidence, consent: true, question: "What is supported?", history: [] }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ diagnostic: { category: "invalid_interpretation" } });
  });
});
