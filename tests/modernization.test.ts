import { describe, expect, it } from "vitest";
import type { Graph, Node } from "../src/lib/archaeology/scanner";
import { investigateFeature, studentPromotionFeature } from "../src/lib/architecture/features";
import { rankFeatureComponents, relevanceGroups } from "../src/lib/architecture/relevance";
import { buildModernizationBlueprint, NEXT_LAYERED } from "../src/lib/architecture/blueprint";

const node = (id: string, kind: Node["kind"], name: string, domain: Node["domain"] = "school-management", path = `application/${id}.php`): Node => ({ id, kind, name, domain, certainty: "observed", method: "fixture", source: { path, startLine: 2, endLine: 8 } });
const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "fixture-snapshot", scan: { fileCount: 3, totalBytes: 100 }, warnings: [], limitations: [], nodes: [
  node("controller", "controller", "promotionCtr", "school-management", "assets/js/main.js"),
  node("endpoint", "endpoint", "index.php/reg/putpromotion"),
  node("service", "method", "Putdatacrtl#putPromotion"),
  node("table", "table", "classes"),
  node("shared", "service", "promotionHelper", "shared-infrastructure"),
  node("score", "method", "Putdatacrtl#putScore"),
], edges: [
  { id: "call", from: "controller", to: "endpoint", kind: "calls-endpoint", certainty: "observed", method: "fixture", source: { path: "assets/js/main.js", startLine: 3, endLine: 3 } },
  { id: "table-ref", from: "service", to: "table", kind: "references-table", certainty: "inferred", method: "fixture", source: { path: "application/service.php", startLine: 4, endLine: 4 } },
  { id: "helper", from: "service", to: "shared", kind: "calls-model-method", certainty: "observed", method: "fixture", source: { path: "application/service.php", startLine: 5, endLine: 5 } },
] };

describe("modernization workspace model", () => {
  const feature = studentPromotionFeature(graph);
  it("ranks core, supporting, and related deterministically with reasons", () => {
    const groups = relevanceGroups(feature);
    expect(groups.core.map(item => item.node.id)).toEqual(["controller", "endpoint", "service"]);
    expect(groups.supporting.map(item => item.node.id)).toEqual(["shared", "table"]);
    expect(groups.related.map(item => item.node.id)).toEqual(["score"]);
    expect(groups.supporting.find(item => item.node.id === "shared")?.reason).toContain("Shared infrastructure");
    expect(rankFeatureComponents(feature).map(item => item.node.id)).toEqual(rankFeatureComponents(studentPromotionFeature({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() })).map(item => item.node.id));
    expect(groups.related[0].evidenceEdgeIds).toEqual([]);
  });
  it("generates stable proposal IDs and distinct recommendation provenance", () => {
    const blueprint = buildModernizationBlueprint(feature, graph.snapshotId);
    expect(blueprint.id).toBe("proposal:promotion:nextjs-layered-v1");
    expect(blueprint.sourceFeatureId).toBe(feature.id);
    expect(blueprint.sourceSnapshotId).toBe(graph.snapshotId);
    expect(blueprint.target).toEqual(NEXT_LAYERED);
    expect(blueprint.proposedComponents.every(item => item.provenance === "modernization-recommendation")).toBe(true);
    expect(blueprint.mappings.every(item => item.provenance === "design-recommendation")).toBe(true);
    expect(blueprint.proposedFlow).toHaveLength(7);
    const alternate = buildModernizationBlueprint(feature, graph.snapshotId, { id: "next-spring-v1", title: "Next.js + Spring Boot", frontend: "Next.js", backend: "Spring Boot", status: "proposed" });
    expect(alternate.id).toBe("proposal:promotion:next-spring-v1");
    expect(alternate.sourceFeatureId).toBe(feature.id);
  });
  it("maps legacy candidates to proposals with source evidence and no fabricated edges", () => {
    const blueprint = buildModernizationBlueprint(feature, graph.snapshotId);
    expect(blueprint.mappings.find(item => item.legacyNodeId === "controller")?.proposedComponentId).toMatch(/:page$/);
    expect(blueprint.mappings.find(item => item.legacyNodeId === "endpoint")?.proposedComponentId).toMatch(/:api$/);
    expect(blueprint.mappings.find(item => item.legacyNodeId === "table")?.proposedComponentId).toMatch(/:entities$/);
    expect(blueprint.mappings.find(item => item.legacyNodeId === "score")?.evidence).toMatchObject({ certainty: "name-match", graphEdgeIds: [] });
    expect(blueprint.mappings.flatMap(item => item.evidence.graphEdgeIds).every(id => graph.edges.some(edge => edge.id === id))).toBe(true);
    expect(blueprint.mappings.every(item => item.evidence.sourceRefs.length > 0)).toBe(true);
  });
  it("keeps operator notes unverified and handles incomplete or unknown features", () => {
    expect(feature.operatorNotes.every(note => note.certainty === "unverified")).toBe(true);
    const empty = investigateFeature({ ...graph, nodes: [], edges: [] }, { term: "unrecognized" });
    const blueprint = buildModernizationBlueprint(empty, graph.snapshotId);
    expect(relevanceGroups(empty)).toEqual({ core: [], supporting: [], related: [] });
    expect(blueprint.mappings).toEqual([]);
    expect(blueprint.assumptions.length).toBeGreaterThan(0);
    expect(blueprint.proposedComponents.every(item => item.provenance === "modernization-recommendation")).toBe(true);
  });
});
