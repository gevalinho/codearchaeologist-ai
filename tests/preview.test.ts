import { describe, expect, it } from "vitest";
import type { Graph } from "../src/lib/archaeology/scanner";
import { buildModernizationBlueprint } from "../src/lib/architecture/blueprint";
import { investigateFeature, studentPromotionFeature } from "../src/lib/architecture/features";
import { createModernizationPreview } from "../src/lib/architecture/preview";
import { initialPromotionDemoState, PROMOTION_DEMO_DATA, reducePromotionDemo, validatePromotionDemo } from "../src/lib/architecture/promotion-demo";

const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "synthetic-snapshot", warnings: [], limitations: [], scan: { fileCount: 1, totalBytes: 100 }, nodes: [
  { id: "controller:promotion", kind: "controller", name: "promotionCtr", domain: "school-management", source: { path: "assets/js/main.js", startLine: 2, endLine: 8 }, certainty: "observed", method: "fixture" },
  { id: "endpoint:promotion", kind: "endpoint", name: "index.php/reg/putpromotion", domain: "school-management", source: { path: "assets/js/main.js", startLine: 5, endLine: 5 }, certainty: "observed", method: "fixture" },
], edges: [{ id: "calls", from: "controller:promotion", to: "endpoint:promotion", kind: "calls-endpoint", source: { path: "assets/js/main.js", startLine: 5, endLine: 5 }, certainty: "observed", method: "fixture" }] };

describe("modernization preview model", () => {
  const feature = studentPromotionFeature(graph);
  const blueprint = buildModernizationBlueprint(feature, graph.snapshotId);
  it("creates stable IDs and valid blueprint references", () => {
    const preview = createModernizationPreview(feature, blueprint)!;
    expect(preview.id).toBe("preview:promotion:nextjs-layered-v1");
    expect(preview.sourceFeatureId).toBe(feature.id);
    expect(preview.blueprintId).toBe(blueprint.id);
    expect(preview.components.every(item => blueprint.proposedComponents.some(component => component.id === item.blueprintComponentId))).toBe(true);
    expect(preview.screens.flatMap(screen => screen.componentIds).every(id => preview.components.some(component => component.id === id))).toBe(true);
    expect(preview.interactions.every(item => preview.components.some(component => component.id === item.componentId) && item.provenance === "demonstration-only")).toBe(true);
    expect(preview.interactions.find(item => item.label === "Reset demonstration")?.componentId).toBe(`${preview.id}:reset`);
  });
  it("keeps synthetic fixtures separate from imported graph and preserves evidence", () => {
    const before = structuredClone(graph);
    const preview = createModernizationPreview(feature, blueprint)!;
    expect(preview.syntheticData.provenance).toBe("synthetic-demonstration-data");
    expect(preview.syntheticData.students.every(student => student.name.startsWith("Demo Learner") && student.id.startsWith("demo-"))).toBe(true);
    expect(preview.components.find(item => item.name === "Student selection table")?.legacySourceRefs).toContainEqual({ path: "assets/js/main.js", startLine: 2, endLine: 8 });
    expect(preview.components.find(item => item.name === "Academic session selector")?.evidenceCertainty).toBe("none");
    expect(preview.components.every(item => item.provenance === "proposed-ux-component" && item.verificationGaps.length > 0)).toBe(true);
    expect(graph).toEqual(before);
  });
  it("rejects broken blueprint mappings and leaves unsupported features without a preview", () => {
    const broken = structuredClone(blueprint);
    broken.mappings[0].proposedComponentId = "missing";
    expect(() => createModernizationPreview(feature, broken)).toThrow("Invalid blueprint mapping");
    const unknown = investigateFeature(graph, { term: "billing" });
    expect(createModernizationPreview(unknown, buildModernizationBlueprint(unknown, graph.snapshotId))).toBeNull();
  });
});

describe("promotion demonstration interactions", () => {
  it("selects, deselects, and resets synthetic learners", () => {
    let state = initialPromotionDemoState();
    state = reducePromotionDemo(state, { type: "source", id: "demo-class-1" });
    state = reducePromotionDemo(state, { type: "toggle", id: "demo-student-01" });
    expect(state.selectedStudentIds).toEqual(["demo-student-01"]);
    state = reducePromotionDemo(state, { type: "toggle", id: "demo-student-01" });
    expect(state.selectedStudentIds).toEqual([]);
    state = reducePromotionDemo(state, { type: "toggle", id: "demo-student-01" });
    state = reducePromotionDemo(state, { type: "source", id: "demo-class-2" });
    expect(state.selectedStudentIds).toEqual([]);
    expect(reducePromotionDemo(state, { type: "reset" })).toEqual(initialPromotionDemoState());
  });
  it("validates only demonstration selections and simulates confirmation locally", () => {
    let state = initialPromotionDemoState();
    state = reducePromotionDemo(state, { type: "review" });
    expect(state.stage).toBe("select");
    expect(state.message).toContain("Choose a demonstration session");
    state = reducePromotionDemo(state, { type: "session", id: PROMOTION_DEMO_DATA.sessions[0].id });
    state = reducePromotionDemo(state, { type: "source", id: "demo-class-1" });
    state = reducePromotionDemo(state, { type: "destination", id: "demo-class-1" });
    state = reducePromotionDemo(state, { type: "toggle", id: "demo-student-01" });
    expect(validatePromotionDemo(state)).toContain("Choose a different destination class for this proposed UX flow.");
    expect(reducePromotionDemo(state, { type: "confirm" })).toEqual(state);
    state = reducePromotionDemo(state, { type: "destination", id: "demo-class-2" });
    state = reducePromotionDemo(state, { type: "review" });
    expect(state.stage).toBe("review");
    state = reducePromotionDemo(state, { type: "confirm" });
    expect(state.stage).toBe("confirmed");
    expect(state.message).toContain("No records were changed");
    expect(reducePromotionDemo(state, { type: "reset" })).toEqual(initialPromotionDemoState());
  });
});
