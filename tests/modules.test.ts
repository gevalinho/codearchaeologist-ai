import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Graph, Node, Edge } from "../src/lib/archaeology/scanner";
import { parseGraph } from "../src/lib/architecture/graph";
import { discoverModules } from "../src/lib/architecture/modules";

const ref = (line: number) => ({ path: "application/controllers/Demo.php", startLine: line, endLine: line });
const node = (id: string, name: string, line: number, domain: Node["domain"] = "school-management", kind: Node["kind"] = "method"): Node => ({ id, name, kind, domain, source: ref(line), certainty: "observed", method: "synthetic-fixture" });
const edge = (id: string, from: string, to: string, line: number, certainty: Edge["certainty"] = "observed"): Edge => ({ id, from, to, kind: "calls", source: ref(line), certainty, method: "synthetic-fixture" });
const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "synthetic-modules", scan: { fileCount: 1, totalBytes: 100 }, warnings: ["Synthetic warning"], limitations: ["Synthetic fixture is incomplete."], nodes: [
  node("p1", "putPromotion", 1), node("p2", "getPromotion", 2), node("a1", "recordAttendance", 3), node("a2", "getAttendance", 4),
  node("auth", "authService", 5, "shared-infrastructure", "service"), node("tp", "ledgerA", 6, "unknown", "table"), node("ta", "ledgerB", 7, "unknown", "table"), node("other", "orphanWidget", 8, "unknown"),
], edges: [edge("e1", "p1", "auth", 9), edge("e2", "a1", "auth", 10), edge("e3", "p2", "tp", 11), edge("e4", "a2", "ta", 12, "inferred"), edge("e5", "tp", "ta", 13)] };

describe("candidate module discovery", () => {
  it("accepts the existing synthetic architecture artifact", () => {
    const fixture = parseGraph(readFileSync(new URL("./fixtures/architecture/demo-graph.json", import.meta.url), "utf8"));
    const result = discoverModules(fixture);
    expect(result.modules.some(module => module.id === "module:promotion")).toBe(true);
    expect(result.coverage.totalComponents).toBe(fixture.nodes.length);
    expect(result.coverage.scannedFiles).toBe(fixture.scan.fileCount);
  });
  it("finds business candidates, shared infrastructure, overlap, and cross-boundary edges", () => {
    const result = discoverModules(graph);
    const promotion = result.modules.find(module => module.id === "module:promotion")!;
    const attendance = result.modules.find(module => module.id === "module:attendance")!;
    const shared = result.modules.find(module => module.id === "module:shared-infrastructure")!;
    expect(promotion.boundaryCertainty).toBe("candidate");
    expect(promotion.memberNodeIds).toContain("auth");
    expect(attendance.memberNodeIds).toContain("auth");
    expect(shared.memberNodeIds).toContain("auth");
    expect(promotion.crossModuleDependencies.map(item => item.id)).toContain("e5");
    expect(attendance.crossModuleDependencies.map(item => item.id)).toContain("e5");
    expect(attendance.evidenceCounts.inferredRelationships).toBe(1);
    expect(promotion.sourceRefs).toContainEqual(ref(1));
    expect(result.coverage.unclassifiedNodeIds).toContain("other");
    expect(result.coverage).toMatchObject({ scannedFiles: 1, totalComponents: 8, observedRelationships: 4, inferredRelationships: 1, warnings: ["Synthetic warning"] });
  });
  it("is deterministic across input order and does not mutate provenance", () => {
    const before = structuredClone(graph);
    const reversed = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
    expect(discoverModules(reversed)).toEqual(discoverModules(graph));
    expect(graph).toEqual(before);
  });
  it("handles sparse graphs without inventing modules or edges", () => {
    const sparse: Graph = { ...graph, nodes: [node("only", "OpaqueThing", 1, "unknown")], edges: [] };
    expect(discoverModules(sparse).modules).toEqual([]);
    expect(discoverModules(sparse).coverage.unclassifiedNodeIds).toEqual(["only"]);
  });
  it("does not turn generic data controllers into business modules", () => {
    const generic: Graph = { ...graph, nodes: [node("g1", "application/controllers/Getdatactrl.php#getData", 1), node("g2", "application/controllers/Getdatactrl.php#getInfo", 2)], edges: [] };
    expect(discoverModules(generic).modules.some(module => module.id === "module:getdatactrl")).toBe(false);
  });
});
