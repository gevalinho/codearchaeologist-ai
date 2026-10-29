import { describe, expect, it } from "vitest";
import type { Graph } from "../src/lib/archaeology/scanner";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import { runAutonomousInvestigation } from "../src/lib/architecture/autonomous-investigation";
import { createAutonomousInvestigationHandler } from "../src/lib/architecture/autonomous-service";
import { executeInvestigationTool, normalizeComponentSearch, parseInvestigationToolCall } from "../src/lib/architecture/investigation-tools";

const nodes = ["Login", "Registration", "User"].flatMap((name, index) => [
  { id: `${name}-controller`, kind: "controller" as const, name: `${name}Controller`, domain: "unknown" as const, certainty: "observed" as const, method: "fixture", source: { path: `application/controllers/${name}.php`, startLine: index * 10 + 1, endLine: index * 10 + 1 } },
  { id: `${name}-method`, kind: "method" as const, name: `${name}Action`, domain: "unknown" as const, certainty: "observed" as const, method: "fixture", source: { path: `application/controllers/${name}.php`, startLine: index * 10 + 2, endLine: index * 10 + 2 } },
]);
const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "autonomous-fixture", nodes, edges: nodes.filter(node => node.kind === "controller").map((node, index) => ({ id: `edge-${index}`, from: node.id, to: `${node.name.replace("Controller", "")}-method`, kind: "declares", source: { ...node.source, startLine: node.source.startLine + 1, endLine: node.source.endLine + 1 }, certainty: "observed", method: "fixture" })), rules: [], warnings: [], limitations: [], scan: { fileCount: 3, totalBytes: 100 }, sourceCoverage: { eligibleFiles: 485, selectedFiles: 300, omittedFiles: 185, analyzedFiles: 3, skippedFiles: 297, partial: true } };
const action = (tool: string, query = "", componentId = "", depth = 0) => ({ tool, query, componentId, depth });
const insufficient = { schemaVersion: "1.0.0", status: "insufficient-evidence", answer: "Insufficient evidence to verify the requested behavior.", evidenceIds: [], uncertainty: "Partial source analysis; omitted files may contain more evidence." };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/autonomous-investigation", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const handler = (provider: MockModelProvider, enabled = true) => createAutonomousInvestigationHandler({ enabled, origin: "http://localhost:3000", createProvider: () => provider, privateAuthorized: () => false, now: () => 20_000 });

describe("autonomous investigation", () => {
  it("executes only validated read-only tools with bounded results and depth", () => {
    expect(normalizeComponentSearch("  Authentication  ")).toEqual(["auth"]);
    expect(normalizeComponentSearch("LoginController")).toEqual(["login", "controller"]);
    expect(parseInvestigationToolCall(action("trace_relationships", "", "Login-controller", 2), graph).tool).toBe("trace_relationships");
    for (const bad of [action("shell", "ls"), action("trace_relationships", "", "Login-controller", 3), action("trace_relationships", "", "missing", 1), action("search_components", ""), { ...action("check_coverage"), url: "https://example.com" }]) expect(() => parseInvestigationToolCall(bad, graph)).toThrow();
    const search = executeInvestigationTool(graph, "search_components", { query: "Login", componentId: "", depth: 0 });
    expect(search.items).toHaveLength(2);
    expect(search.items.every(item => item.source.path.endsWith("Login.php"))).toBe(true);
    expect(executeInvestigationTool(graph, "search_components", { query: "lOg", componentId: "", depth: 0 }).matchCount).toBe(2);
    expect(executeInvestigationTool(graph, "search_components", { query: "LoginController", componentId: "", depth: 0 }).matchCount).toBe(2);
    const authGraph: Graph = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0], id: "auth-service", name: "AuthService", source: { path: "application/services/Auth.php", startLine: 1, endLine: 1 } }] };
    expect(executeInvestigationTool(authGraph, "search_components", { query: "authentication", componentId: "", depth: 0 }).matchCount).toBe(1);
    const empty = executeInvestigationTool(graph, "search_components", { query: "authentication", componentId: "", depth: 0 });
    expect(empty).toMatchObject({ matchCount: 0, items: [] });
    expect(empty.summary).toContain("omitted files were not searched");
    const trace = executeInvestigationTool(graph, "trace_relationships", { query: "", componentId: "Login-controller", depth: 1 });
    expect(trace.items).toHaveLength(1);
    expect(trace.items[0].certainty).toBe("observed");
    expect(executeInvestigationTool(graph, "check_coverage", { query: "", componentId: "", depth: 0 }).summary).toContain("185 omitted");
    const extended: Graph = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0], id: "third-hop", name: "ThirdHop", source: { path: "application/controllers/Third.php", startLine: 1, endLine: 1 } }], edges: [...graph.edges, { id: "inferred", from: "Login-method", to: "third-hop", kind: "calls", certainty: "inferred", method: "fixture", source: { path: "application/controllers/Third.php", startLine: 2, endLine: 2 } }] };
    const twoHops = executeInvestigationTool(extended, "trace_relationships", { query: "", componentId: "Login-controller", depth: 2 });
    expect(twoHops.items.some(entry => entry.certainty === "inferred")).toBe(true);
    expect(executeInvestigationTool(extended, "trace_relationships", { query: "", componentId: "Login-controller", depth: 1 }).items.some(entry => entry.certainty === "inferred")).toBe(false);
  });

  it("rejects repeated empty search proposals without spending another tool call", async () => {
    const provider = new MockModelProvider([action("search_components", "authentication"), action("search_components", "AUTHENTICATION"), action("find_feature_candidates"), action("finish"), insufficient]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate authentication", provider, new AbortController().signal, () => undefined);
    expect(report.actions.map(item => item.tool)).toEqual(["search_components", "find_feature_candidates"]);
    expect(report.actions[0]).toMatchObject({ query: "auth", matchCount: 0 });
    expect(provider.requests[2].input).toContain("That exact normalized search previously returned zero matches");
    expect(provider.requests).toHaveLength(5);
  });

  it("completes with an uncited partial-coverage report after only unsuccessful searches", async () => {
    const provider = new MockModelProvider([action("search_components", "authentication"), action("search_components", "sessionguard"), action("search_components", "identityprovider")]);
    const events: unknown[] = [];
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate authentication", provider, new AbortController().signal, event => events.push(event));
    expect(provider.requests).toHaveLength(3);
    expect(report.answer.status).toBe("insufficient-evidence");
    expect(report.answer.evidenceIds).toEqual([]);
    expect(report.answer.uncertainty).toContain("185 eligible files were omitted");
    expect(report.actions.map(item => item.query)).toEqual(["auth", "sessionguard", "identityprovider"]);
    expect(events).toHaveLength(4);
  });

  it("returns safe final validation rules for citations, unsafe text, and partial disclosure", async () => {
    const variants = [
      [{ ...insufficient, status: "observed-structure", answer: "Observed a login component.", evidenceIds: ["fabricated"] }, "citation_unknown"],
      [{ ...insufficient, answer: "Insufficient evidence <script>bad</script>." }, "unsafe_text"],
      [{ ...insufficient, uncertainty: "Runtime behavior is unknown." }, "partial_coverage"],
      [{ schemaVersion: "1.0.0", status: "insufficient-evidence", answer: "Insufficient evidence.", evidenceIds: [], uncertainty: "" }, "structure"],
    ] as const;
    for (const [answer, rule] of variants) {
      const response = await handler(new MockModelProvider([action("finish"), answer]))(request({ graph, origin: "public-github", goal: "Investigate authentication", consent: true }));
      const output = await response.text();
      expect(output).toContain(`"rule":"${rule}"`);
      expect(output).not.toContain("fabricated");
      expect(output).not.toContain("<script>");
    }
  });

  it("stops after three tool calls, emits only completed actions, and accepts insufficient evidence", async () => {
    const provider = new MockModelProvider([action("search_components", "Login"), action("trace_relationships", "", "Login-controller", 1), action("check_coverage"), insufficient]);
    const events: unknown[] = [];
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate authentication", provider, new AbortController().signal, event => events.push(event));
    expect(provider.requests).toHaveLength(4);
    expect(report.actions.map(item => item.tool)).toEqual(["search_components", "trace_relationships", "check_coverage"]);
    expect(events).toHaveLength(4);
    expect(report.answer.status).toBe("insufficient-evidence");
    expect(report.sourceCoverage?.omittedFiles).toBe(185);
    expect(provider.requests.every(item => item.input.length <= 16_000 && item.maxOutputTokens <= 900)).toBe(true);
    expect(provider.requests[0].input).not.toContain("sourceBody");
  });

  it("rejects fabricated final citations and invalid model tool actions", async () => {
    const invented = { ...insufficient, status: "observed-structure", answer: "Observed a login component.", evidenceIds: ["fabricated"] };
    await expect(runAutonomousInvestigation(graph, "public-github", "Investigate login", new MockModelProvider([action("finish"), invented]), new AbortController().signal, () => undefined)).rejects.toThrow();
    await expect(runAutonomousInvestigation(graph, "public-github", "Investigate login", new MockModelProvider([action("shell", "ls")]), new AbortController().signal, () => undefined)).rejects.toThrow();
    const abort = new AbortController(); abort.abort();
    const provider = new MockModelProvider([]);
    await expect(runAutonomousInvestigation(graph, "public-github", "Investigate login", provider, abort.signal, () => undefined)).rejects.toThrow(/cancelled/);
    expect(provider.requests).toHaveLength(0);
    const midRun = new AbortController(), midProvider = new MockModelProvider([action("check_coverage"), insufficient]);
    await expect(runAutonomousInvestigation(graph, "public-github", "Investigate login", midProvider, midRun.signal, () => midRun.abort())).rejects.toThrow(/cancelled/);
    expect(midProvider.requests).toHaveLength(1);
  });

  it("gates provider calls on consent, origin, private authorization, and rate limit", async () => {
    const provider = new MockModelProvider([action("finish"), insufficient]);
    const handle = handler(provider);
    expect((await handle(request({ graph, origin: "public-github", goal: "Investigate login", consent: false }))).status).toBe(400);
    expect((await handle(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }, { Origin: "https://evil.example" }))).status).toBe(403);
    expect((await handle(request({ graph, origin: "private-github", goal: "Investigate login", consent: true }))).status).toBe(401);
    expect(provider.requests).toHaveLength(0);
    const response = await handle(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }));
    expect(response.status).toBe(200);
    expect((await response.text()).includes('"type":"complete"')).toBe(true);
    expect((await handle(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }))).status).toBe(429);
    expect((await handler(new MockModelProvider([]), false)(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }))).status).toBe(503);
  });

  it("returns a safe stream failure for provider errors without source or secret text", async () => {
    const response = await handler(new MockModelProvider([new Error("secret provider body")]))(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }));
    const text = await response.text();
    expect(text).toContain('"type":"error"');
    expect(text).toContain('"category":"invalid_investigation"');
    expect(text).not.toContain("secret provider body");
  });
});
