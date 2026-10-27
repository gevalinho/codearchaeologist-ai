import { describe, expect, it } from "vitest";
import type { Graph, Node } from "../src/lib/archaeology/scanner";
import { discoverFeatures, featureTerms, investigateFeature, studentPromotionFeature } from "../src/lib/architecture/features";

const node = (id: string, kind: Node["kind"], name: string, certainty: Node["certainty"] = "observed"): Node => ({ id, kind, name, domain: "school-management", certainty, method: "fixture", source: { path: `application/${id}.php`, startLine: 10, endLine: 20 } });
const fixture: Graph = { schemaVersion: "1.0.0", snapshotId: "synthetic", warnings: [], limitations: [], scan: { fileCount: 4, totalBytes: 100 }, nodes: [
  node("a", "controller", "promotionCtr"), node("b", "endpoint", "index.php/reg/putpromotion"), node("c", "method", "Putdatacrtl#putPromotion"), node("d", "table", "classes"), node("e", "method", "Putdatacrtl#putScore"), node("f", "table", "result"), node("g", "method", "Getdatactrl#getPromotion", "inferred"), node("h", "controller", "billingCtr"), node("i", "endpoint", "index.php/gett/billing")
], edges: [
  { id: "ab", from: "a", to: "b", kind: "calls-endpoint", certainty: "observed", method: "fixture", source: { path: "assets/js/main.js", startLine: 5, endLine: 5 } },
  { id: "cd", from: "c", to: "d", kind: "references-table", certainty: "inferred", method: "fixture", source: { path: "application/controllers/Putdatacrtl.php", startLine: 30, endLine: 30 } },
  { id: "ef", from: "e", to: "f", kind: "references-table", certainty: "observed", method: "fixture", source: { path: "application/controllers/Putdatacrtl.php", startLine: 40, endLine: 40 } },
  { id: "hi", from: "h", to: "i", kind: "calls-endpoint", certainty: "observed", method: "fixture", source: { path: "assets/js/main.js", startLine: 50, endLine: 50 } },
] };

describe("feature intelligence", () => {
  it("assigns stable IDs and deterministic discovery order", () => {
    expect(investigateFeature(fixture, { term: "Promotion" }).id).toBe("feature:promotion");
    expect(discoverFeatures(fixture).map(feature => feature.id)).toEqual(discoverFeatures({ ...fixture, nodes: [...fixture.nodes].reverse(), edges: [...fixture.edges].reverse() }).map(feature => feature.id));
    expect(discoverFeatures(fixture).some(feature => feature.id === "feature:promotion")).toBe(true);
    expect(discoverFeatures({ ...fixture, nodes: fixture.nodes.filter(node => !node.name.toLowerCase().includes("promotion")), edges: [] }).some(feature => feature.id === "feature:promotion")).toBe(false);
    expect(featureTerms("Getdatactrl#putPromotion")).toContain("promotion");
  });
  it("separates graph relationships from name associations", () => {
    const feature = studentPromotionFeature(fixture);
    expect(feature.relationships.map(edge => edge.id)).toEqual(["ab", "cd"]);
    expect(feature.components.find(item => item.node.id === "d")?.association).toBe("relationship");
    expect(feature.components.find(item => item.node.id === "e")?.association).toBe("name-match");
    expect(feature.components.find(item => item.node.id === "f")?.association).toBe("name-match");
    expect(feature.relationships.some(edge => edge.id === "ef")).toBe(false);
  });
  it("preserves source provenance and certainty without fabricating rules", () => {
    const feature = studentPromotionFeature(fixture);
    expect(feature.readiness.observedEdges).toBe(1);
    expect(feature.readiness.inferredEdges).toBe(1);
    expect(feature.explanation.find(claim => claim.certainty === "inferred")?.edgeIds).toEqual(["cd"]);
    expect(feature.sourceRefs.some(ref => ref.path === "assets/js/main.js" && ref.startLine === 5)).toBe(true);
    expect(feature.businessRules).toEqual([]);
    expect(feature.nextInspection.some(step => step.includes("inferred relationships"))).toBe(true);
    expect(feature.operatorNotes.every(claim => claim.evidenceType === "operator-note" && claim.certainty === "unverified" && claim.sourceRefs.length === 0)).toBe(true);
  });
  it("reports missing and disconnected components as uncertainty", () => {
    const feature = studentPromotionFeature(fixture);
    expect(feature.missingComponents).toContain("getCollatedResultinput");
    expect(feature.unresolvedQuestions.some(question => question.includes("name-matched"))).toBe(true);
    expect(feature.components.find(item => item.node.id === "g")?.association).toBe("anchor");
    expect(feature.components.find(item => item.node.id === "g")?.viaEdgeIds).toEqual([]);
  });
  it("handles malformed or incomplete metadata without unsafe references", () => {
    const bad = structuredClone(fixture);
    (bad.nodes[0].source as { path: string }).path = "../secret.php";
    (bad.edges[0] as { source: unknown }).source = null;
    (bad as { warnings: unknown }).warnings = null;
    const feature = studentPromotionFeature(bad);
    expect(feature.components.some(item => item.node.id === "a")).toBe(false);
    expect(feature.relationships.some(edge => edge.id === "ab")).toBe(false);
    expect(feature.sourceRefs.every(ref => !ref.path.includes(".."))).toBe(true);
  });
});
