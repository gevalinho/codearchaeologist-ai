import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BusinessRuleEvidence, Edge, Graph, Node } from "../src/lib/archaeology/scanner";
import { investigateFeature, studentPromotionFeature } from "../src/lib/architecture/features";
import { classifyFeature } from "../src/lib/architecture/feature-classification";
import { planReconstruction } from "../src/lib/architecture/reconstruction-planner";
import { initialReconstructionState, parseReconstructionSpec, submitReconstruction, updateReconstructionField } from "../src/lib/architecture/reconstruction-spec";
import ReconstructionRenderer from "../src/app/architecture/reconstruction-renderer";
import { buildModernizationBlueprint } from "../src/lib/architecture/blueprint";
import { createModernizationPreview } from "../src/lib/architecture/preview";
import demoGraph from "./fixtures/architecture/demo-graph.json";

const ref = (path: string, line: number) => ({ path, startLine: line, endLine: line });
const node = (id: string, name: string, kind: Node["kind"], path: string): Node => ({ id, name, kind, domain: "unknown", source: ref(path, 1), certainty: "observed", method: "fixture" });
const edge = (id: string, from: string, to: string, path: string): Edge => ({ id, from, to, kind: "calls-endpoint", source: ref(path, 4), certainty: "observed", method: "fixture" });
const rule = (ownerNodeId: string, path: string, kind: BusinessRuleEvidence["kind"] = "validation"): BusinessRuleEvidence => ({ id: `rule:${path}:3:${kind}`, kind, description: "Validates input in a conditional branch.", ownerNodeId, source: ref(path, 3), certainty: "observed", method: "deterministic-rule-pattern-v1" });
const controllerPath = "application/controllers/OrderController.php";
const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "snapshot-order", scan: { fileCount: 1, totalBytes: 100 }, warnings: [], limitations: [], nodes: [node("controller", "OrderController", "controller", controllerPath), node("service", "OrderService", "service", controllerPath), node("endpoint", "/orders", "endpoint", controllerPath)], edges: [edge("call", "controller", "endpoint", controllerPath)], rules: [rule("controller", controllerPath)] };
const feature = investigateFeature(graph, { term: "order" });

describe("dynamic reconstruction foundation", () => {
  it("classifies an evidence-backed workflow without claiming runtime verification", () => {
    const result = classifyFeature(graph, feature);
    expect(result.category).toBe("business-workflow");
    expect(result.strength).toBe("moderate");
    expect(result.ruleIds).toEqual([graph.rules![0].id]);
    expect(result.sourceRefs).toContainEqual(ref(controllerPath, 3));
    expect(result.uncertainty.join(" ")).toMatch(/runtime behavior/);
  });
  it("separates technical, data-access, and ambiguous candidates", () => {
    const technical = { ...graph, nodes: [node("auth", "AuthController", "controller", "application/controllers/AuthController.php")], edges: [], rules: [] };
    expect(classifyFeature(technical, investigateFeature(technical, { term: "auth" })).category).toBe("shared-utility");
    const data = { ...graph, nodes: [node("model", "application/models/OrderRepository.php#find", "method", "application/models/OrderRepository.php")], edges: [], rules: [] };
    expect(classifyFeature(data, investigateFeature(data, { term: "order" })).category).toBe("data-access");
    const controller = { ...graph, nodes: [node("controller", "OrderController", "controller", controllerPath)], edges: [], rules: [] };
    expect(classifyFeature(controller, investigateFeature(controller, { term: "order" })).category).toBe("technical-controller");
    const uncertain = { ...graph, nodes: [node("widget", "OrderWidget", "service", controllerPath)], edges: [], rules: [] };
    expect(classifyFeature(uncertain, investigateFeature(uncertain, { term: "order" })).category).toBe("uncertain");
  });
  it("does not promote unrelated generic Edit methods into one business workflow", () => {
    const path = "application/controllers/Putdatactrl.php";
    const editGraph: Graph = { ...graph, nodes: [node("class-edit", `${path}#editClass`, "method", path), node("teacher-edit", `${path}#editTeachers`, "method", path), node("model", "ClassModel", "method", "application/models/ClassModel.php")], edges: [{ ...edge("class-call", "class-edit", "model", path), kind: "calls-model-method" }], rules: [rule("class-edit", path)] };
    const edit = investigateFeature(editGraph, { term: "edit" });
    const classification = classifyFeature(editGraph, edit);
    expect(classification.category).toBe("technical-controller");
    expect(classification.explanation).toMatch(/different subjects/);
    expect(planReconstruction(editGraph, edit).status).toBe("unavailable");
  });
  it("returns structured insufficiency for old artifacts and technical candidates", () => {
    const old = { ...graph, rules: undefined };
    const result = planReconstruction(old, investigateFeature(old, { term: "order" }));
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(result.reasons.join(" ")).toMatch(/predates business-rule extraction/);
    const technical = { ...graph, nodes: [node("auth", "AuthController", "controller", "application/controllers/AuthController.php")], edges: [], rules: [] };
    expect(planReconstruction(technical, investigateFeature(technical, { term: "auth" })).status).toBe("unavailable");
  });
  it("validates a declarative proposal and rejects malformed or ungrounded specifications", () => {
    const result = planReconstruction(graph, feature);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    const spec = result.spec;
    expect(parseReconstructionSpec(spec, graph)).toEqual(spec);
    expect(() => parseReconstructionSpec({ ...spec, schemaVersion: "2.0.0" })).toThrow(/Invalid reconstruction/);
    expect(() => parseReconstructionSpec({ ...spec, execute: "alert(1)" })).toThrow(/Invalid reconstruction/);
    expect(() => parseReconstructionSpec({ ...spec, evidence: { ...spec.evidence, ruleIds: ["made-up"] } }, graph)).toThrow(/Invalid reconstruction/);
    expect(() => parseReconstructionSpec({ ...spec, screens: [{ ...spec.screens[0], fields: [{ ...spec.screens[0].fields[0], label: "<script>" }] }, spec.screens[1]] })).toThrow(/Invalid reconstruction/);
  });
  it("renders generic controls and performs required checks and synthetic state transitions", () => {
    const result = planReconstruction(graph, feature);
    if (result.status !== "available") throw new Error("Expected available proposal");
    const spec = result.spec;
    const markup = renderToStaticMarkup(createElement(ReconstructionRenderer, { specification: spec }));
    expect(markup).toContain("SYNTHETIC PROPOSAL");
    expect(markup).toContain('type="text"');
    expect(markup).toContain("<select");
    expect(markup).not.toContain("No repository behavior");
    let state = initialReconstructionState(spec);
    state = submitReconstruction(spec, state);
    expect(state).toMatchObject({ screen: "draft", error: expect.stringContaining("required") });
    state = updateReconstructionField(state, "record-label", "Synthetic order A");
    expect(state).toMatchObject({ values: { "record-label": "Synthetic order A" }, error: "" });
    state = updateReconstructionField(state, "review-state", "invalid");
    expect(submitReconstruction(spec, state).error).toMatch(/invalid synthetic option/);
    state = updateReconstructionField(state, "review-state", "reviewed");
    expect(submitReconstruction(spec, state)).toMatchObject({ screen: "submitted", error: "" });
    const calculationGraph = { ...graph, rules: [rule("controller", controllerPath, "calculation")] };
    const calculation = planReconstruction(calculationGraph, investigateFeature(calculationGraph, { term: "order" }));
    if (calculation.status !== "available") throw new Error("Expected numeric proposal");
    const numeric = updateReconstructionField(initialReconstructionState(calculation.spec), "sample-value", 2);
    expect(numeric.values["sample-value"]).toBe(2);
  });
  it("keeps the existing Student Promotion preview operational", () => {
    const promotion = studentPromotionFeature(demoGraph as Graph);
    const blueprint = buildModernizationBlueprint(promotion, demoGraph.snapshotId);
    expect(createModernizationPreview(promotion, blueprint)?.provenance).toBe("deterministic-preview-template-v1");
  });
});
