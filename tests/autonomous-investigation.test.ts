import { describe, expect, it } from "vitest";
import type { Graph } from "../src/lib/archaeology/scanner";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import { runAutonomousInvestigation } from "../src/lib/architecture/autonomous-investigation";
import { createAutonomousInvestigationHandler } from "../src/lib/architecture/autonomous-service";
import { parseRepositoryAnswer, RepositoryAnswerValidationError } from "../src/lib/architecture/ai-repository-chat";
import { createRepositoryEvidencePacket } from "../src/lib/architecture/ai-repository-evidence";
import { discoverFeatures } from "../src/lib/architecture/features";
import { executeInvestigationTool, InvestigationToolValidationError, normalizeComponentSearch, parseInvestigationToolCall } from "../src/lib/architecture/investigation-tools";

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

  it("accepts the six model-facing examples and identifies each argument failure without raw values", async () => {
    const provider = new MockModelProvider([action("finish"), insufficient]);
    await runAutonomousInvestigation(graph, "public-github", "Investigate login", provider, new AbortController().signal, () => undefined);
    const input = JSON.parse(provider.requests[0].input) as { validActionExamples: ReturnType<typeof action>[] };
    expect(input.validActionExamples.map(item => item.tool)).toEqual(["search_components", "trace_relationships", "inspect_rule_patterns", "find_feature_candidates", "check_coverage", "finish"]);
    for (const example of input.validActionExamples.filter(item => item.tool !== "finish")) expect(() => parseInvestigationToolCall(example, graph)).not.toThrow();
    expect(provider.requests[0].schema).toMatchObject({ properties: { query: { description: expect.stringContaining("80 characters") }, componentId: { description: expect.stringContaining("500 characters") }, depth: { description: expect.stringContaining("1 or 2") } } });
    const invalid = [
      [{ tool: "search_components", query: "Auth", componentId: "" }, "missing_fields"],
      [{ ...action("search_components", "Auth"), url: "https://example.com" }, "unexpected_fields"],
      [action("shell", "ls"), "unknown_tool"],
      [{ ...action("search_components"), query: 7 }, "query_type"],
      [action("search_components", "a".repeat(81)), "query_limit"],
      [action("search_components", "<script>"), "unsafe_query"],
      [{ ...action("check_coverage"), componentId: 7 }, "component_id_type"],
      [action("check_coverage", "", "x".repeat(501)), "component_id_limit"],
      [{ ...action("check_coverage"), depth: "2" }, "depth_type"],
      [action("trace_relationships", "", "Login-controller", 3), "depth_range"],
      [action("trace_relationships", "", "missing", 1), "relationship_target"],
      [action("trace_relationships", "", "Login-controller", 0), "relationship_target"],
      [action("inspect_rule_patterns", "", "missing"), "rule_target"],
      [action("search_components", ""), "search_query_required"],
    ] as const;
    for (const [value, rule] of invalid) {
      try { parseInvestigationToolCall(value, graph); throw new Error("Expected rejection"); }
      catch (cause) { expect(cause).toBeInstanceOf(InvestigationToolValidationError); expect(cause).toMatchObject({ rule }); }
    }
  });

  it("corrects tool arguments once, then reports only stage, tool, and rule on failure", async () => {
    const invalid = action("trace_relationships", "", "missing", 1);
    const recovered = new MockModelProvider([invalid, action("check_coverage"), action("finish"), insufficient]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate login", recovered, new AbortController().signal, () => undefined);
    expect(report.actions.map(item => item.tool)).toEqual(["check_coverage"]);
    expect(recovered.requests[1].input).toContain("relationship_target");
    expect(recovered.requests[1].input).not.toContain('"componentId":"missing"');
    const failed = await handler(new MockModelProvider([invalid, invalid]))(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }));
    const output = await failed.text();
    expect(output).toContain('"category":"action_validation","rule":"tool_arguments","stage":"action_selection","tool":"trace_relationships","argumentRule":"relationship_target"');
    expect(output).not.toContain("missing");
  });

  it("moves to final validation after two correctable argument errors with prior evidence", async () => {
    const cited = { schemaVersion: "1.0.0", status: "observed-structure", answer: "Login components appear in the analyzed graph.", evidenceIds: ["r2"], uncertainty: "Partial source analysis; omitted files may contain further relationships." };
    const invalid = action("trace_relationships", "", "missing", 1);
    const provider = new MockModelProvider([action("search_components", "Login"), invalid, invalid, cited]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate login", provider, new AbortController().signal, () => undefined);
    expect(report.actions).toHaveLength(1);
    expect(provider.requests.at(-1)?.name).toBe("investigation_report_v1");
    const unsafe = await handler(new MockModelProvider([action("search_components", "Login"), action("search_components", "<script>"), action("search_components", "<script>")]))(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }));
    expect(await unsafe.text()).toContain('"argumentRule":"unsafe_query"');
    const extra = await handler(new MockModelProvider([action("search_components", "Login"), { ...action("check_coverage"), command: "ls" }, { ...action("check_coverage"), command: "ls" }]))(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }));
    expect(await extra.text()).toContain('"argumentRule":"unexpected_fields"');
  });

  it("rejects repeated empty search proposals without spending another tool call", async () => {
    const provider = new MockModelProvider([action("search_components", "authentication"), action("search_components", "AUTHENTICATION"), action("find_feature_candidates"), action("finish"), insufficient]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate authentication", provider, new AbortController().signal, () => undefined);
    expect(report.actions.map(item => item.tool)).toEqual(["search_components", "find_feature_candidates"]);
    expect(report.actions[0]).toMatchObject({ query: "auth", matchCount: 0 });
    expect(provider.requests[2].input).toContain("This normalized search was already executed and adds no new information");
    expect(provider.requests).toHaveLength(5);
  });

  it("keeps a successful search, rejects an identical repeat, and executes a different tool", async () => {
    const cited = { schemaVersion: "1.0.0", status: "observed-structure", answer: "Login components appear in the analyzed graph.", evidenceIds: ["r2"], uncertainty: "Partial source analysis; omitted files may contain further relationships." };
    const provider = new MockModelProvider([action("search_components", "Login"), action("search_components", "LOGIN"), action("check_coverage"), { tool: "finish" }, cited]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate login", provider, new AbortController().signal, () => undefined);
    expect(report.actions.map(item => item.tool)).toEqual(["search_components", "check_coverage"]);
    expect(report.actions[0].matchCount).toBe(2);
    expect(report.answer.evidenceIds).toEqual(["r2"]);
    expect(provider.requests[2].input).toContain("already executed");
  });

  it("uses focused search terms after an empty multi-term search and can finish with evidence", async () => {
    const cited = { schemaVersion: "1.0.0", status: "observed-structure", answer: "Login components appear in the analyzed graph.", evidenceIds: ["r2"], uncertainty: "Partial source analysis; omitted files may contain further relationships." };
    const provider = new MockModelProvider([action("search_components", "Auth Access Permission Role User"), action("search_components", "Login"), action("finish"), cited]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate login", provider, new AbortController().signal, () => undefined);
    expect(report.actions.map(item => item.matchCount)).toEqual([0, 2]);
    expect(report.answer).toEqual(cited);
    expect(provider.requests[0].instructions).toContain("All query terms must match the same component");
    expect(provider.requests[2].input).toContain('"remainingToolCalls":1');
    expect(provider.requests[2].input).toContain('"finalReportRequestedSeparately":true');
    expect(provider.requests[3].name).toBe("investigation_report_v1");
  });

  it("corrects malformed actions after useful evidence, then requests a strictly validated report", async () => {
    const cited = { schemaVersion: "1.0.0", status: "observed-structure", answer: "Login components appear in the analyzed graph.", evidenceIds: ["r2"], uncertainty: "Partial source analysis; omitted files may contain further relationships." };
    const malformed = { tool: "finish", query: "Login" };
    const provider = new MockModelProvider([action("search_components", "Login"), malformed, malformed, cited]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate login", provider, new AbortController().signal, () => undefined);
    expect(report.actions).toHaveLength(1);
    expect(report.answer).toEqual(cited);
    expect(provider.requests.map(item => item.name)).toEqual(["investigation_action_v1", "investigation_action_v1", "investigation_action_v1", "investigation_report_v1"]);
    expect(provider.requests[2].input).toContain("Invalid action shape");
    expect(provider.requests[2].schema).toEqual(provider.requests[1].schema);
    expect(provider.requests[3].input).toContain('"phase":"final_report"');
    const invalid = new MockModelProvider([action("search_components", "Login"), malformed, malformed, { ...cited, evidenceIds: ["fabricated"] }]);
    const response = await handler(invalid)(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }));
    expect(await response.text()).toContain('"category":"final_validation","rule":"citation_unknown"');
  });

  it("keeps malformed actions as errors when no tool evidence exists or tool selection is invalid", async () => {
    const malformed = { tool: "finish", query: "Auth" };
    const noEvidence = await handler(new MockModelProvider([action("search_components", "missing"), malformed, malformed]))(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }));
    expect(await noEvidence.text()).toContain('"category":"action_validation","rule":"action_structure"');
    const unknown = await handler(new MockModelProvider([action("search_components", "Login"), action("shell", "ls"), action("shell", "ls")]))(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }));
    expect(await unknown.text()).toContain('"category":"action_validation","rule":"tool_selection"');
  });

  it("moves to the final report when a successful search is repeated twice", async () => {
    const cited = { schemaVersion: "1.0.0", status: "observed-structure", answer: "Login components appear in the analyzed graph.", evidenceIds: ["r2"], uncertainty: "Partial source analysis; omitted files may contain further relationships." };
    const provider = new MockModelProvider([action("search_components", "Login"), action("search_components", "login"), action("search_components", "LOGIN"), cited]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate login", provider, new AbortController().signal, () => undefined);
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0].matchCount).toBe(2);
    expect(provider.requests.at(-1)?.name).toBe("investigation_report_v1");
  });

  it("labels distinct trace targets without exposing IDs and rejects an identical repeated trace", async () => {
    const events: Array<{ type: string; targetRef?: string }> = [];
    const provider = new MockModelProvider([action("search_components", "Login"), action("trace_relationships", "", "Login-controller", 1), action("trace_relationships", "", "User-controller", 1), insufficient]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate authentication", provider, new AbortController().signal, event => events.push(event));
    expect(report.actions.map(item => item.targetRef)).toEqual([undefined, "target-1", "target-2"]);
    expect(report.actions[1].summary).toBe(report.actions[2].summary);
    expect(events.filter(item => item.type === "tool").map(item => item.targetRef)).toEqual([undefined, "target-1", "target-2"]);
    expect(JSON.stringify(events.filter(item => item.type === "tool"))).not.toContain("Login-controller");
    expect(JSON.stringify(events.filter(item => item.type === "tool"))).not.toContain("User-controller");
    const repeated = new MockModelProvider([action("search_components", "Login"), action("trace_relationships", "", "Login-controller", 1), action("trace_relationships", "", "Login-controller", 1), action("trace_relationships", "", "User-controller", 1), insufficient]);
    const repeatedReport = await runAutonomousInvestigation(graph, "public-github", "Investigate authentication", repeated, new AbortController().signal, () => undefined);
    expect(repeatedReport.actions.map(item => item.targetRef)).toEqual([undefined, "target-1", "target-2"]);
    expect(repeated.requests[3].input).toContain("already traced");
    expect(repeated.requests.filter(item => item.name === "investigation_action_v1")).toHaveLength(4);
  });

  it("accepts truthful insufficient evidence after positive searches and traces", async () => {
    const provider = new MockModelProvider([action("search_components", "Login"), action("trace_relationships", "", "Login-controller", 1), action("check_coverage"), insufficient]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate runtime authentication", provider, new AbortController().signal, () => undefined);
    expect(report.answer.status).toBe("insufficient-evidence");
    expect(report.answer.evidenceIds).toEqual([]);
    expect(report.answer.uncertainty).toContain("Partial source analysis");
    expect(provider.requests[3].instructions).toContain("including when searches or traces found components");
  });

  it("distinguishes the two insufficient-evidence validation rules without leaking report text", async () => {
    for (const [invalid, answerRule] of [
      [{ ...insufficient, evidenceIds: ["r2"] }, "citations_present"],
      [{ ...insufficient, answer: "The available evidence is insufficient." }, "answer_prefix"],
    ] as const) {
      const response = await handler(new MockModelProvider([action("finish"), invalid]))(request({ graph, origin: "public-github", goal: "Investigate authentication", consent: true }));
      const output = await response.text();
      expect(output).toContain(`"category":"final_validation","rule":"insufficient_evidence","answerRule":"${answerRule}"`);
      expect(output).not.toContain(invalid.answer);
    }
  });

  it("accepts a valid report after all three action slots and a short finish discriminator", async () => {
    const cited = { schemaVersion: "1.0.0", status: "observed-structure", answer: "Login components appear in the analyzed graph.", evidenceIds: ["r2"], uncertainty: "Partial source analysis; omitted files may contain further relationships." };
    const afterBudget = new MockModelProvider([action("search_components", "Login"), action("check_coverage"), action("inspect_rule_patterns"), cited]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate login", afterBudget, new AbortController().signal, () => undefined);
    expect(report.actions).toHaveLength(3);
    expect(afterBudget.requests.map(request => request.name)).toEqual(["investigation_action_v1", "investigation_action_v1", "investigation_action_v1", "investigation_report_v1"]);
    expect(report.answer).toEqual(cited);
    const shortFinish = new MockModelProvider([{ tool: "finish" }, insufficient]);
    expect((await runAutonomousInvestigation(graph, "public-github", "Investigate login", shortFinish, new AbortController().signal, () => undefined)).answer.status).toBe("insufficient-evidence");
  });

  it("reprompts a premature report as an action and rejects repeated invalid action shapes", async () => {
    const recovered = new MockModelProvider([insufficient, { tool: "finish" }, insufficient]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate login", recovered, new AbortController().signal, () => undefined);
    expect(report.answer.status).toBe("insufficient-evidence");
    expect(recovered.requests[1].input).toContain("report during action selection");
    const badFinish = action("finish", "Auth");
    const response = await handler(new MockModelProvider([badFinish, badFinish]))(request({ graph, origin: "public-github", goal: "Investigate login", consent: true }));
    expect(await response.text()).toContain('"category":"action_validation","rule":"action_structure"');
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
      if (rule === "unsafe_text") expect(output).toContain('"field":"answer","textRule":"html_delimiter"');
    }
  });

  it("accepts technical prose and exact cited source references but rejects unsupported references and unsafe text", () => {
    const packet = createRepositoryEvidencePacket(graph, discoverFeatures(graph), "public-github");
    const cited = packet.items[0];
    const base = { schemaVersion: "1.0.0", status: "observed-structure", answer: `AuthService and authorization controllers are structural terms. See ${cited.source.path}:${cited.source.startLine}.`, evidenceIds: [cited.id], uncertainty: "Partial source analysis; 185 eligible files were omitted." };
    expect(parseRepositoryAnswer(base, packet)).toEqual(base);
    const rejected = [
      [{ ...base, answer: "See application/controllers/Invented.php:42." }, "source_reference"],
      [{ ...base, answer: `See /${cited.source.path}:${cited.source.startLine}.` }, "source_reference"],
      [{ ...base, answer: `See ${cited.source.path}:${cited.source.startLine}.`, evidenceIds: [packet.items[1].id] }, "source_reference"],
      [{ ...base, answer: "See Login.php without a validated line reference." }, "source_reference"],
      [{ ...base, answer: "Inspect <script>alert(1)</script>." }, "html_delimiter"],
      [{ ...base, answer: "Visit https://example.com." }, "unsafe_url"],
      [{ ...base, answer: "Line one\nline two." }, "control_character"],
    ] as const;
    for (const [answer, rule] of rejected) {
      try { parseRepositoryAnswer(answer, packet); throw new Error("Expected rejection"); }
      catch (cause) { expect(cause).toBeInstanceOf(RepositoryAnswerValidationError); expect(cause).toMatchObject({ category: "unsafe_text", field: "answer", rule }); }
    }
    expect(() => parseRepositoryAnswer({ ...base, evidenceIds: ["fabricated"] }, packet)).toThrowError(new RepositoryAnswerValidationError("citation_unknown"));
  });

  it("emits only field and stable rule identifiers for unsafe final text", async () => {
    const invalid = { ...insufficient, answer: "Insufficient evidence; see application/controllers/Invented.php:42." };
    const response = await handler(new MockModelProvider([action("finish"), invalid]))(request({ graph, origin: "public-github", goal: "Investigate authentication", consent: true }));
    const output = await response.text();
    expect(output).toContain('"category":"final_validation","rule":"unsafe_text","field":"answer","textRule":"source_reference"');
    expect(output).not.toContain("Invented.php");
  });

  it("keeps a valid final report after three tool actions and gives the model the source-reference contract", async () => {
    const cited = { schemaVersion: "1.0.0", status: "observed-structure", answer: "LoginController appears in the analyzed graph.", evidenceIds: ["r2"], uncertainty: "Partial source analysis; 185 eligible files were omitted." };
    const provider = new MockModelProvider([action("search_components", "Login"), action("search_components", "User"), action("check_coverage"), cited]);
    const report = await runAutonomousInvestigation(graph, "public-github", "Investigate authentication", provider, new AbortController().signal, () => undefined);
    expect(report.actions).toHaveLength(3);
    expect(report.answer).toEqual(cited);
    expect(provider.requests[3].instructions).toContain("exact submitted relative path and line reference");
    expect(provider.requests[3].instructions).toContain("Do not use bare filenames");
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
