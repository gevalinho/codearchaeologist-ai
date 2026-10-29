import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Graph } from "../src/lib/archaeology/scanner";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import { createEvidencePacket } from "../src/lib/architecture/ai-evidence";
import { createRepositoryEvidencePacket } from "../src/lib/architecture/ai-repository-evidence";
import { appendAssistantAnswer, assistantContextId, assistantNeedsConsent, emptyAssistantThread } from "../src/lib/architecture/assistant-context";
import { createAiInterpretationHandler } from "../src/lib/architecture/ai-service";
import { discoverFeatures } from "../src/lib/architecture/features";
import { planReconstruction } from "../src/lib/architecture/reconstruction-planner";
import WorkspaceAssistant from "../src/app/architecture/workspace-assistant";
import { WorkspaceNavigation } from "../src/app/architecture/workspace-navigation";

const ref = { path: "application/controller/Login.php", startLine: 3, endLine: 3 };
const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "assistant-snapshot", scan: { fileCount: 1, totalBytes: 100 }, nodes: [
  { id: "login-controller", kind: "controller", name: "LoginController", domain: "unknown", certainty: "observed", method: "fixture", source: ref },
  { id: "login-method", kind: "method", name: "LoginAction", domain: "unknown", certainty: "observed", method: "fixture", source: { ...ref, startLine: 4, endLine: 4 } },
], edges: [], rules: [], warnings: [], limitations: [] };
const feature = discoverFeatures(graph)[0];
const repositoryPacket = createRepositoryEvidencePacket(graph, [feature], "browser-local");
const featurePacket = createEvidencePacket(graph, feature, planReconstruction(graph, feature), "browser-local");
const request = (body: unknown) => new Request("https://app.example/api/feature-interpretation", { method: "POST", headers: { Origin: "https://app.example", "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("workspace AI assistant", () => {
  it("supports a direct question-first repository request without an interpretation call", async () => {
    const answer = { schemaVersion: "1.0.0", status: "observed-structure", answer: "A Login candidate was identified by static analysis.", evidenceIds: [repositoryPacket.candidates[0].evidenceId], uncertainty: "Runtime behavior is unverified." };
    const provider = new MockModelProvider([answer]);
    const handle = createAiInterpretationHandler({ enabled: true, origin: "https://app.example", developmentAccess: true, createProvider: () => provider, privateAuthorized: () => false, now: () => 20_000 });
    expect((await handle(request({ packet: repositoryPacket, consent: false, question: "What features?", history: [] }))).status).toBe(400);
    expect(provider.requests).toHaveLength(0);
    const response = await handle(request({ packet: repositoryPacket, consent: true, question: "What features?", history: [] }));
    expect(response.status).toBe(200);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].name).toBe("repository_chat_v1");
    expect(await response.json()).toMatchObject({ answer });
  });

  it("invalidates consent for changed packets and separates feature context", () => {
    const repositoryId = assistantContextId("repository", repositoryPacket)!;
    const featureId = assistantContextId("feature", featurePacket)!;
    const consent = new Set([repositoryId]);
    expect(assistantNeedsConsent(repositoryId, consent)).toBe(false);
    expect(assistantNeedsConsent(featureId, consent)).toBe(true);
    expect(assistantNeedsConsent(assistantContextId("repository", { ...repositoryPacket, limitations: [...repositoryPacket.limitations, "Changed evidence coverage."] }), consent)).toBe(true);
    expect(assistantContextId("repository", featurePacket)).toBeNull();
    expect(assistantContextId("feature", repositoryPacket)).toBeNull();
    expect(assistantContextId("repository", { ...repositoryPacket, snapshotId: "other-repository" })).not.toBe(repositoryId);
  });

  it("bounds conversation history, preserves messages, and isolates contexts", () => {
    let repositoryThread = emptyAssistantThread();
    for (let index = 0; index < 5; index++) repositoryThread = appendAssistantAnswer(repositoryThread, `Question ${index}`, { answer: `Answer ${index}`, evidenceIds: [repositoryPacket.items[0].id], uncertainty: "Static only.", status: "observed-structure" });
    const featureThread = emptyAssistantThread();
    expect(repositoryThread.messages).toHaveLength(5);
    expect(repositoryThread.history).toHaveLength(6);
    expect(featureThread.messages).toHaveLength(0);
    expect(repositoryThread.history[0].text).toBe("Question 2");
  });

  it("renders launcher, empty state, scope controls, and citation-ready drawer", () => {
    const nav = renderToStaticMarkup(createElement(WorkspaceNavigation, { active: "architecture", onSelect: () => undefined, busy: false, assistantOpen: false, onToggleAssistant: () => undefined }));
    expect(nav).toContain('aria-label="Open AI assistant"');
    expect(nav).toContain('aria-controls="workspace-assistant"');
    const empty = renderToStaticMarkup(createElement(WorkspaceAssistant, { open: true, onClose: () => undefined, repositoryName: "", graph: null, origin: null, repositoryPacket: null, featurePacket: null, featureName: null, onFocusEvidence: () => undefined }));
    expect(empty).toContain("Analyze or import a repository");
    expect(empty).toContain("Select a feature in Workflows");
    const ready = renderToStaticMarkup(createElement(WorkspaceAssistant, { open: true, onClose: () => undefined, repositoryName: "example/login", graph, origin: "browser-local", repositoryPacket, featurePacket, featureName: feature.title, onFocusEvidence: () => undefined }));
    expect(ready).toContain("example/login");
    expect(ready).toContain("Ask a question about the current scope");
    expect(ready).toContain("Send");
  });

  it("keeps production access closed and returns sanitized provider errors", async () => {
    const provider = new MockModelProvider([new Error("private provider diagnostic")]);
    const denied = createAiInterpretationHandler({ enabled: false, origin: "https://app.example", createProvider: () => provider, privateAuthorized: () => false });
    expect((await denied(request({ packet: repositoryPacket, consent: true, question: "Why?", history: [] }))).status).toBe(503);
    expect(provider.requests).toHaveLength(0);
    const enabled = createAiInterpretationHandler({ enabled: true, origin: "https://app.example", developmentAccess: true, createProvider: () => provider, privateAuthorized: () => false, now: () => 20_000 });
    const failed = await enabled(request({ packet: repositoryPacket, consent: true, question: "Why?", history: [] }));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private provider diagnostic");
  });
});
