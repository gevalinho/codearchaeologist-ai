import type { Graph } from "../archaeology/scanner";
import type { FeatureInvestigation } from "./features";
import { classifyFeature, type FeatureClassification } from "./feature-classification";
import { parseReconstructionSpec, type ReconstructionSpec } from "./reconstruction-spec";

export type ReconstructionPlan = { status: "available"; classification: FeatureClassification; spec: ReconstructionSpec } | { status: "unavailable"; classification: FeatureClassification; reasons: string[] };

/** The planner proposes a neutral review interface; it never translates source patterns into claimed business actions. */
export function planReconstruction(graph: Graph, feature: FeatureInvestigation): ReconstructionPlan {
  const classification = classifyFeature(graph, feature);
  if (classification.category !== "business-workflow") return { status: "unavailable", classification, reasons: [classification.explanation, ...classification.uncertainty] };
  const rules = (graph.rules ?? []).filter(rule => classification.ruleIds.includes(rule.id)).slice(0, 30);
  if (!rules.length || !classification.edgeIds.length) return { status: "unavailable", classification, reasons: ["Rule evidence and an observed operational relationship are required before proposing an interface."] };
  const refs = [...new Map(rules.map(rule => [`${rule.source.path}:${rule.source.startLine}:${rule.source.endLine}`, rule.source])).values()].slice(0, 30);
  const hasCalculation = rules.some(rule => rule.kind === "calculation");
  const fields: ReconstructionSpec["screens"][number]["fields"] = [
    { id: "record-label", label: "Synthetic record label", type: "text", required: true },
    { id: "review-state", label: "Proposed review state", type: "select", required: true, options: [{ value: "needs-review", label: "Needs review" }, { value: "reviewed", label: "Reviewed" }] },
    ...(hasCalculation ? [{ id: "sample-value", label: "Synthetic numeric input", type: "number" as const, required: true, min: 0, max: 1_000_000 }] : []),
  ];
  const candidate: ReconstructionSpec = {
    schemaVersion: "1.0.0", id: `reconstruction:${feature.id}`, featureId: feature.id, sourceSnapshotId: graph.snapshotId,
    status: "synthetic-proposal", evidence: { ruleIds: rules.map(rule => rule.id), sourceRefs: refs },
    screens: [
      { id: "review-form", state: "draft", title: `${feature.title} review proposal`, description: "Enter synthetic values to explore a possible review interface. These fields are proposed UX, not extracted legacy fields.", fields, action: { id: "submit-review", label: "Show synthetic result", kind: "submit", toState: "submitted" }, readOnlySummary: false },
      { id: "review-result", state: "submitted", title: "Synthetic result", description: "Browser-local demonstration complete. No repository behavior was executed or verified.", fields: [], readOnlySummary: true },
    ],
    syntheticData: { "review-state": "needs-review", ...(hasCalculation ? { "sample-value": 0 } : {}) },
    assumptions: ["The review form, field labels, options, required checks, and transition are proposed UX only.", "No legacy business outcome is calculated or reproduced."],
    uncertainty: [...classification.uncertainty, "The source patterns require human review before business semantics can be reconstructed."],
  };
  return { status: "available", classification, spec: parseReconstructionSpec(candidate, graph) };
}
