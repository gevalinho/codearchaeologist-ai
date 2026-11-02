import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { InvestigationReport } from "../src/lib/architecture/autonomous-investigation";
import WorkspaceAssistant, { groupTimelineEvents, InvestigationReportView, InvestigationTimeline, type TimelineToolEvent } from "../src/app/architecture/workspace-assistant";

vi.mock("server-only", () => ({}));

const trace = (query: string, summary: string): TimelineToolEvent => ({ type: "tool", tool: "trace_source_flow", summary, query });
const search = (query: string): TimelineToolEvent => ({ type: "tool", tool: "search_components", summary: "2 matching analyzed components; up to 12 references returned.", query });

const report: InvestigationReport = {
  goal: "How does login reach the backend?",
  answer: { schemaVersion: "1.0.0", status: "observed-structure", answer: "A Login candidate was identified by static analysis.", evidenceIds: ["n1"], uncertainty: "Runtime behavior is unverified." },
  actions: [{ tool: "trace_source_flow", summary: "1 bounded source trace.", query: "login" }],
  items: [
    { id: "n1", kind: "component", label: "controller: LoginController", certainty: "observed", source: { path: "application/controllers/Login.php", startLine: 3, endLine: 3 }, supportingSources: [{ path: "application/models/User.php", startLine: 12, endLine: 12 }] },
    { id: "e1", kind: "relationship", label: "calls", certainty: "inferred", source: { path: "application/controllers/Login.php", startLine: 20, endLine: 20 } },
    { id: "r1", kind: "rule", label: "validation", certainty: "observed", source: { path: "application/controllers/Login.php", startLine: 30, endLine: 30 } },
  ],
};

describe("investigation timeline grouping", () => {
  it("groups consecutive trace_source_flow runs and preserves every query and summary", () => {
    const grouped = groupTimelineEvents([trace("login", "First trace summary."), trace("route", "Second trace summary."), search("Auth")]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ kind: "traceGroup" });
    expect(grouped[0].kind === "traceGroup" ? grouped[0].events.map(e => e.query) : []).toEqual(["login", "route"]);
    expect(grouped[1]).toMatchObject({ kind: "single" });
  });

  it("keeps lone traces and separated runs ungrouped", () => {
    expect(groupTimelineEvents([trace("login", "Only trace.")])).toHaveLength(1);
    expect(groupTimelineEvents([trace("login", "Only trace.")])[0].kind).toBe("single");
    const separated = groupTimelineEvents([trace("a", "First."), search("Auth"), trace("b", "Second.")]);
    expect(separated.map(e => e.kind)).toEqual(["single", "single", "single"]);
    expect(groupTimelineEvents([])).toEqual([]);
  });

  it("renders grouped runs once with both queries and summaries", () => {
    const html = renderToStaticMarkup(createElement(InvestigationTimeline, { events: [trace("login", "First trace summary."), trace("route", "Second trace summary."), search("Auth")] }));
    expect(html).toContain("Trace source flow · 2 runs");
    expect(html).toContain("login — First trace summary.");
    expect(html).toContain("route — Second trace summary.");
    expect(html).toContain("search components · Auth");
    expect(renderToStaticMarkup(createElement(InvestigationTimeline, { events: [trace("login", "Only trace.")] }))).toContain("trace source flow · login");
    expect(renderToStaticMarkup(createElement(InvestigationTimeline, { events: [] }))).toBe("");
  });
});

describe("investigation report polish", () => {
  const render = (value: InvestigationReport = report) => renderToStaticMarkup(createElement(InvestigationReportView, { report: value, onFocusEvidence: () => undefined }));

  it("keeps the finding and supporting evidence prominently visible", () => {
    const html = render();
    expect(html).toContain("Evidence-backed finding");
    expect(html).toContain("A Login candidate was identified by static analysis.");
    expect(html).toContain("Supporting evidence");
    expect(html).toContain("controller: LoginController · application/controllers/Login.php:3 · observed");
    expect(html).toContain("Supporting source · application/models/User.php:12");
    expect(html).toContain("Next inspection");
  });

  it("collapses lengthy metadata, uncertainty, and modernization sections", () => {
    const html = render();
    expect(html).toContain("<summary>Relevant structural metadata</summary>");
    expect(html).toContain("<summary>Uncertainty and coverage</summary>");
    expect(html).toContain("<summary>Modernization considerations</summary>");
    expect(html).toContain("Representative components:");
    expect(html).toContain("Runtime behavior is unverified.");
  });

  it("preserves observed/inferred classifications, tooltips, and the insufficient-evidence contract", () => {
    const html = render();
    expect(html).toContain("calls (inferred)");
    expect(html).toContain('title="controller: LoginController · application/controllers/Login.php:3 · observed"');
    expect(html).toContain('title="application/models/User.php:12"');
    const weak = render({ ...report, answer: { ...report.answer, status: "insufficient-evidence", answer: "Insufficient evidence to establish the flow.", evidenceIds: [] } });
    expect(weak).toContain("Investigation outcome");
    expect(weak).toContain("Insufficient evidence to establish the flow.");
  });

  it("keeps the assistant shell and report button styling narrow-screen safe", () => {
    const css = readFileSync("src/app/architecture/workspace-assistant.css", "utf8");
    expect(css).toContain(".workspace-investigation-section summary{cursor:pointer");
    expect(css).toContain(".workspace-investigation-report button,.workspace-assistant-hint button{margin:5px 5px 0 0;padding:6px;max-width:100%");
    expect(css).toContain("@media(max-width:700px)");
  });

  it("leaves the existing assistant entry points untouched", () => {
    const shell = renderToStaticMarkup(createElement(WorkspaceAssistant, { open: true, onClose: () => undefined, repositoryName: "", graph: null, origin: null, repositoryPacket: null, featurePacket: null, featureName: null, onFocusEvidence: () => undefined }));
    expect(shell).toContain("MUSE SPARK");
    expect(shell).toContain("Analyze or import a repository");
  });
});
