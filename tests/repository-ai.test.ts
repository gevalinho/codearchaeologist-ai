import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Graph } from "../src/lib/archaeology/scanner";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import { allowedSource } from "../src/lib/archaeology/selection";
import { createEvidencePacket, parseEvidencePacket } from "../src/lib/architecture/ai-evidence";
import { parseChatHistory } from "../src/lib/architecture/ai-chat";
import { parseRepositoryAnswer, RepositoryAnswerValidationError, repositoryChatInstructions } from "../src/lib/architecture/ai-repository-chat";
import { createRepositoryEvidencePacket, parseRepositoryEvidencePacket } from "../src/lib/architecture/ai-repository-evidence";
import { createAiInterpretationHandler } from "../src/lib/architecture/ai-service";
import { discoverFeatures } from "../src/lib/architecture/features";
import { planReconstruction } from "../src/lib/architecture/reconstruction-planner";
import RepositoryAiPanel from "../src/app/architecture/repository-ai-panel";

const terms = ["Core", "Login", "Registration", "Password", "Reset", "User"];
const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "repo-snapshot", scan: { fileCount: 6, totalBytes: 1000 }, nodes: terms.flatMap((term, index) => [
  { id: `${term}-controller`, kind: "controller" as const, name: `${term}Controller`, domain: "unknown" as const, certainty: "observed" as const, method: "fixture", source: { path: `application/controller/${term}.php`, startLine: index * 10 + 1, endLine: index * 10 + 1 } },
  { id: `${term}-method`, kind: "method" as const, name: `${term}Action`, domain: "unknown" as const, certainty: "observed" as const, method: "fixture", source: { path: `application/controller/${term}.php`, startLine: index * 10 + 2, endLine: index * 10 + 2 } },
]), edges: terms.map((term, index) => ({ id: `${term}-edge`, from: `${term}-controller`, to: `${term}-method`, kind: "declares", source: { path: `application/controller/${term}.php`, startLine: index * 10 + 2, endLine: index * 10 + 2 }, certainty: "observed" as const, method: "fixture" })), rules: [], warnings: [], limitations: [] };
const features = discoverFeatures(graph);
const repo = () => createRepositoryEvidencePacket(graph, features, "public-github");
const feature = features.find(item => item.id === "feature:core")!;
const featurePacket = () => createEvidencePacket(graph, feature, planReconstruction(graph, feature), "public-github");
const key = "x".repeat(40);
const request = (body: unknown) => new Request("https://app.example/api/feature-interpretation", { method: "POST", headers: { Origin: "https://app.example", "Content-Type": "application/json", "x-codearchaeologist-ai-access-key": key }, body: JSON.stringify(body) });
const handler = (provider: MockModelProvider) => createAiInterpretationHandler({ enabled: true, origin: "https://app.example", accessKey: key, createProvider: () => provider, privateAuthorized: () => false, now: () => 20_000 });

describe("repository-wide AI evidence", () => {
  it("separates repository and selected-feature evidence and selects candidates deterministically", () => {
    const packet = repo();
    expect(repo()).toEqual(packet);
    expect(packet.scope).toBe("repository");
    expect(packet.candidates.map(item => item.title)).toContain("Login candidate");
    expect(packet.candidates.map(item => item.title)).toContain("Registration candidate");
    expect(packet.candidates[0].title).not.toBe("Core candidate");
    expect(featurePacket().items.some(item => item.label.includes("Login"))).toBe(false);
    expect(packet.items.some(item => item.label.includes("Login"))).toBe(true);
    expect(() => parseEvidencePacket(packet)).toThrow();
    expect(() => parseRepositoryEvidencePacket(featurePacket())).toThrow();
  });

  it("deduplicates references, discloses truncation, and enforces caps", () => {
    const packet = repo();
    expect(new Set(packet.items.map(item => `${item.source.path}:${item.source.startLine}`)).size).toBe(packet.items.length);
    expect(packet.items.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(packet).length).toBeLessThanOrEqual(16_000);
    const extras = Array.from({ length: 12 }, (_, index) => ({ ...features[0], id: `feature:extra${index}`, title: `Extra${index} candidate`, components: features[0].components.map(part => ({ ...part, node: { ...part.node, name: `Extra${index}Controller`, source: { path: `application/controller/Extra${index}.php`, startLine: index + 100, endLine: index + 100 } } })) }));
    const truncated = createRepositoryEvidencePacket(graph, [...features, ...extras], "public-github");
    expect(truncated.coverage.truncated).toBe(true);
    expect(truncated.coverage.omittedCandidateGroups).toBeGreaterThan(0);
    expect(() => parseRepositoryEvidencePacket({ ...packet, excerpts: ["source body"] })).toThrow();
    expect(() => parseRepositoryEvidencePacket({ ...packet, items: [...packet.items, ...Array.from({ length: 40 }, () => packet.items[0])] })).toThrow();
  });

  it("requires candidate anchors for purpose inference and rejects invented citations", () => {
    const packet = repo(), ids = ["feature:login", "feature:registration"].map(id => packet.candidates.find(candidate => candidate.id === id)!.evidenceId);
    const answer = { schemaVersion: "1.0.0", status: "inference", answer: "Login and registration candidates suggest authentication capability; runtime behavior is unverified.", evidenceIds: ids, uncertainty: "Static names alone do not prove reachability." };
    expect(parseRepositoryAnswer(answer, packet)).toEqual(answer);
    expect(() => parseRepositoryAnswer({ ...answer, evidenceIds: [ids[0]] }, packet)).toThrow();
    expect(() => parseRepositoryAnswer({ ...answer, evidenceIds: ["invented", ids[0]] }, packet)).toThrow();
    expect(() => parseRepositoryAnswer({ ...answer, status: "insufficient-evidence" }, packet)).toThrow();
    expect(() => parseChatHistory([{ role: "user", text: "Question" }, { role: "assistant", text: "From another feature", evidenceIds: ["foreign"] }], packet)).toThrow();
  });

  it("classifies repository answer failures without exposing model text", () => {
    const packet = repo(), ids = ["feature:login", "feature:registration"].map(id => packet.candidates.find(candidate => candidate.id === id)!.evidenceId);
    const answer = { schemaVersion: "1.0.0", status: "inference", answer: "Login and registration candidates suggest authentication; partial source analysis means runtime behavior is unverified.", evidenceIds: ids, uncertainty: "Partial source analysis; omitted files may contain more evidence." };
    expect(parseRepositoryAnswer(answer, packet)).toEqual(answer);
    const insufficient = { ...answer, status: "insufficient-evidence", answer: "Insufficient evidence to determine repository purpose from this partial source analysis.", evidenceIds: [] };
    expect(parseRepositoryAnswer(insufficient, packet)).toEqual(insufficient);
    const invalid = [
      [{ ...answer, status: "other" }, "classification"],
      [{ ...answer, evidenceIds: [ids[0], "invented"] }, "citation_unknown"],
      [{ ...answer, evidenceIds: [ids[0]] }, "purpose_anchors"],
      [{ ...answer, answer: "Login and registration candidates suggest authentication.", evidenceIds: [ids[0]] }, "purpose_anchors"],
      [{ ...answer, status: "observed-structure", evidenceIds: [ids[0]] }, "candidate_anchor"],
      [{ ...insufficient, evidenceIds: [ids[0]] }, "insufficient_evidence"],
      [{ ...answer, schemaVersion: "2.0.0" }, "structure"],
    ] as const;
    for (const [value, category] of invalid) {
      try { parseRepositoryAnswer(value, packet); throw new Error("Expected validation failure"); }
      catch (cause) { expect(cause).toBeInstanceOf(RepositoryAnswerValidationError); expect((cause as RepositoryAnswerValidationError).category).toBe(category); }
    }
    expect(repositoryChatInstructions).toContain("no more than four named candidates");
    expect(repositoryChatInstructions).toContain("For any status inference, cite at least two distinct candidate anchors");
  });

  it("returns only a safe repository validation category while feature interpretation stays independent", async () => {
    const packet = repo(), provider = new MockModelProvider([{ schemaVersion: "1.0.0", status: "inference", answer: "Unsupported purpose", evidenceIds: ["invented"], uncertainty: "Unknown." }]);
    const response = await handler(provider)(request({ packet, consent: true, question: "What is this?", history: [] }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.diagnostic).toEqual({ category: "invalid_interpretation", validationCategory: "citation_unknown" });
    expect(JSON.stringify(body)).not.toContain("invented");
    expect(provider.requests[0].name).toBe("repository_chat_v1");
  });

  it("accepts legitimate structural prose, safe emphasis, and an exact cited source reference", () => {
    const packet = repo(), cited = packet.items[0];
    const answer = { schemaVersion: "1.0.0", status: "observed-structure", answer: `**Static structure:** controllers/models appear related; see \`${cited.source.path}:${cited.source.startLine}\`.`, evidenceIds: [cited.id], uncertainty: "Partial source analysis may omit additional relationships." };
    expect(parseRepositoryAnswer(answer, packet)).toEqual(answer);
    expect(parseRepositoryAnswer({ ...answer, answer: "Controllers/models and routes/services appear in the graph." }, packet)).toBeTruthy();
  });

  it("reproduces the slash-phrase false positive and returns field-specific safe diagnostics", async () => {
    const packet = repo(), cited = packet.items[0];
    const answer = { schemaVersion: "1.0.0", status: "observed-structure", answer: "The controllers/models structure is visible in analyzed files.", evidenceIds: [cited.id], uncertainty: "Runtime behavior remains unverified." };
    expect(parseRepositoryAnswer(answer, packet)).toEqual(answer);
    const invalid = { ...answer, uncertainty: "Review app/controllers/Invented.php:999 before concluding." };
    const response = await handler(new MockModelProvider([invalid]))(request({ packet, consent: true, question: "What is visible?", history: [] }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.diagnostic).toEqual({ category: "invalid_interpretation", validationCategory: "unsafe_text", field: "uncertainty", rule: "source_reference" });
    expect(JSON.stringify(body)).not.toContain("Invented.php");
  });

  it("rejects unsafe HTML, URLs, uncited source references, and invalid citation IDs", () => {
    const packet = repo(), cited = packet.items[0];
    const base = { schemaVersion: "1.0.0", status: "observed-structure", answer: "Static component observed.", evidenceIds: [cited.id], uncertainty: "Partial source analysis." };
    const cases = [
      [{ ...base, answer: "<script>alert(1)</script>" }, "answer", "html_delimiter"],
      [{ ...base, answer: "[click](javascript:alert(1))" }, "answer", "unsafe_url"],
      [{ ...base, uncertainty: "Visit https://example.com" }, "uncertainty", "unsafe_url"],
      [{ ...base, answer: `See ${cited.source.path}:${cited.source.startLine}`, evidenceIds: [packet.items[1].id] }, "answer", "source_reference"],
      [{ ...base, answer: "Line one\nLine two" }, "answer", "control_character"],
    ] as const;
    for (const [value, field, rule] of cases) {
      try { parseRepositoryAnswer(value, packet); throw new Error("Expected text rejection"); }
      catch (cause) { expect(cause).toBeInstanceOf(RepositoryAnswerValidationError); expect(cause).toMatchObject({ category: "unsafe_text", field, rule }); }
    }
    expect(() => parseRepositoryAnswer({ ...base, evidenceIds: ["made-up"] }, packet)).toThrowError(new RepositoryAnswerValidationError("citation_unknown"));
  });

  it("accepts a bounded insufficient-evidence answer for partial coverage", async () => {
    const partialGraph: Graph = { ...graph, sourceCoverage: { eligibleFiles: 485, selectedFiles: 300, analyzedFiles: 300, omittedFiles: 185, skippedFiles: 0, partial: true } };
    const packet = createRepositoryEvidencePacket(partialGraph, features, "public-github");
    const answer = { schemaVersion: "1.0.0", status: "insufficient-evidence", answer: "Insufficient evidence to determine repository purpose.", evidenceIds: [], uncertainty: "Partial source analysis; 185 eligible files were omitted." };
    const response = await handler(new MockModelProvider([answer]))(request({ packet, consent: true, question: "What does this repository do?", history: [] }));
    expect(response.status).toBe(200);
    expect((await response.json()).answer).toEqual(answer);
    const markup = renderToStaticMarkup(createElement(RepositoryAiPanel, { packet, onFocusEvidence: () => undefined, onSelectedFeature: () => undefined }));
    expect(markup).toContain("185 omitted");
    expect(markup).toContain("Missing features or relationships cannot be ruled out");
  });

  it("requires separate consent and validates the repository provider response", async () => {
    const packet = repo(), ids = packet.candidates.slice(0, 2).map(candidate => candidate.evidenceId);
    const answer = { schemaVersion: "1.0.0", status: "inference", answer: "These candidates suggest authentication capabilities; runtime behavior is unverified.", evidenceIds: ids, uncertainty: "Static names only." };
    const provider = new MockModelProvider([answer]);
    const handle = handler(provider);
    expect((await handle(request({ packet, consent: false, question: "What does this do?", history: [] }))).status).toBe(400);
    expect(provider.requests).toHaveLength(0);
    const response = await handle(request({ packet, consent: true, question: "What does this do?", history: [] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: "repository", snapshotId: packet.snapshotId, answer });
    expect(provider.requests[0].name).toBe("repository_chat_v1");
    expect(provider.requests[0].input).not.toContain("sourceBody");
  });

  it("allows a named Password PHP controller while keeping sensitive paths excluded", () => {
    expect(allowedSource("application/controller/Password.php")).toBe(true);
    expect(allowedSource("application/controllers/Password.php")).toBe(true);
    for (const path of ["Password.php", "app/config/Password.php", "application/controller/password.php", "application/controller/passwords.php", "application/controller/credentials.php", "application/controller/.env.php"]) expect(allowedSource(path)).toBe(false);
    const packet = repo();
    expect(packet.items.some(item => item.source.path.endsWith("Password.php"))).toBe(true);
    expect(() => parseRepositoryEvidencePacket({ ...packet, items: packet.items.map(item => item.source.path.endsWith("Password.php") ? { ...item, source: { ...item.source, path: "app/config/Password.php" } } : item) })).toThrow();
  });

  it("shows the selected scope, coverage, review details, and a separate consent gate", () => {
    const markup = renderToStaticMarkup(createElement(RepositoryAiPanel, { packet: repo(), onFocusEvidence: () => undefined, onSelectedFeature: () => undefined }));
    expect(markup).toContain("Repository overview");
    expect(markup).toContain("Selected feature");
    expect(markup).toContain("candidate groups");
    expect(markup).toContain("Review repository metadata before sharing");
    expect(markup).toContain("disabled");
  });
});
