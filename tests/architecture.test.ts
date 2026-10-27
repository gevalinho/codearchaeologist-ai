import { describe, expect, it } from "vitest";
import type { Graph } from "../src/lib/archaeology/scanner";
import { filterNodes, layout, MAX_ARTIFACT_BYTES, neighborhood, parseGraph, promotionInvestigation, safePath, sourceReference } from "../src/lib/architecture/graph";

const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "synthetic", scan: { fileCount: 2, totalBytes: 100 }, warnings: [], limitations: [], nodes: [
  { id: "controller:promotionCtr", kind: "controller", name: "assets/js/main.js#promotionCtr", domain: "school-management", certainty: "observed", method: "fixture", source: { path: "assets/js/main.js", startLine: 3, endLine: 7 } },
  { id: "endpoint:putpromotion", kind: "endpoint", name: "index.php/reg/putpromotion", domain: "school-management", certainty: "observed", method: "fixture", source: { path: "assets/js/main.js", startLine: 5, endLine: 5 } },
  { id: "table:classes", kind: "table", name: "classes", domain: "unknown", certainty: "inferred", method: "fixture", source: { path: "application/models/a.php", startLine: 2, endLine: 2 } },
], edges: [{ id: "edge-1", from: "controller:promotionCtr", to: "endpoint:putpromotion", kind: "calls-endpoint", certainty: "observed", method: "fixture", source: { path: "assets/js/main.js", startLine: 5, endLine: 5 } }] };
const mutate = (change: (value: Graph) => void) => { const value = structuredClone(graph); change(value); return JSON.stringify(value); };
describe("architecture artifact", () => {
  it("imports a valid graph and formats source references", () => { expect(parseGraph(JSON.stringify(graph)).nodes).toHaveLength(3); expect(sourceReference(graph.nodes[0].source)).toBe("assets/js/main.js:3-7"); });
  it("rejects unsupported, oversized, duplicate, broken and unsafe data", () => {
    expect(() => parseGraph(mutate(value => { (value as { schemaVersion: string }).schemaVersion = "2.0.0"; }))).toThrow("schema");
    expect(() => parseGraph(JSON.stringify(graph), MAX_ARTIFACT_BYTES + 1)).toThrow("5 MB");
    expect(() => parseGraph(mutate(value => value.nodes.push(value.nodes[0])))).toThrow("Duplicate node");
    expect(() => parseGraph(mutate(value => value.edges.push(value.edges[0])))).toThrow("Duplicate edge");
    expect(() => parseGraph(mutate(value => { value.edges[0].to = "missing"; }))).toThrow("missing node");
    expect(() => parseGraph(mutate(value => { value.nodes[0].source.path = "../private.php"; }))).toThrow("source");
    expect(safePath("C:\\private.php")).toBe(false);
  });
  it("searches and filters domain, type and certainty", () => {
    expect(filterNodes(graph.nodes, { query: "promotion", domains: new Set(), kinds: new Set(), certainties: new Set() })).toHaveLength(2);
    expect(filterNodes(graph.nodes, { query: "", domains: new Set(["unknown"]), kinds: new Set(["table"]), certainties: new Set(["inferred"]) }).map(node => node.id)).toEqual(["table:classes"]);
  });
  it("traverses actual directed edges with stable layout", () => {
    expect(neighborhood(graph, ["endpoint:putpromotion"], 1, "incoming").nodes).toHaveLength(2);
    expect(neighborhood(graph, ["endpoint:putpromotion"], 1, "outgoing").nodes).toHaveLength(1);
    expect(neighborhood(graph, ["table:classes"], 1).edges).toHaveLength(0);
    expect([...layout(graph.nodes)]).toEqual([...layout([...graph.nodes].reverse())]);
  });
  it("selects only present promotion components and reports missing ones", () => {
    const result = promotionInvestigation(graph);
    expect(result.matches.map(item => item.term)).toContain("promotionCtr");
    expect(result.missing).toContain("putScore");
    expect(result.view.edges).toHaveLength(1);
  });
});
