import type { SourceRef } from "../archaeology/scanner";
import type { FeatureInvestigation } from "./features";
import type { ModernizationBlueprint } from "./blueprint";
import { safePath } from "./graph";
import { PROMOTION_DEMO_DATA, type PromotionDemoData } from "./promotion-demo";

export type PreviewComponent = { id: string; name: string; responsibility: string; blueprintComponentId: string; legacyNodeIds: string[]; legacySourceRefs: SourceRef[]; evidenceCertainty: "observed" | "inferred" | "name-match" | "none"; verificationGaps: string[]; provenance: "proposed-ux-component" };
export type PreviewScreen = { id: string; title: string; description: string; componentIds: string[] };
export type PreviewInteraction = { id: string; label: string; componentId: string; effect: string; provenance: "demonstration-only" };
export type ModernizationPreview = { id: string; sourceFeatureId: string; blueprintId: string; sourceSnapshotId: string; screens: PreviewScreen[]; components: PreviewComponent[]; interactions: PreviewInteraction[]; syntheticData: PromotionDemoData; assumptions: string[]; unresolvedQuestions: string[]; provenance: "deterministic-preview-template-v1" };

function validateBlueprint(feature: FeatureInvestigation, blueprint: ModernizationBlueprint): void {
  if (blueprint.sourceFeatureId !== feature.id) throw new Error("Blueprint feature mismatch");
  const componentIds = new Set(blueprint.proposedComponents.map(item => item.id));
  const nodeIds = new Set(feature.components.map(item => item.node.id));
  const edgeIds = new Set(feature.relationships.map(edge => edge.id));
  if (componentIds.size !== blueprint.proposedComponents.length || blueprint.proposedFlow.some(id => !componentIds.has(id))) throw new Error("Invalid blueprint component reference");
  for (const mapping of blueprint.mappings) {
    if (!componentIds.has(mapping.proposedComponentId) || !nodeIds.has(mapping.legacyNodeId) || mapping.evidence.graphEdgeIds.some(id => !edgeIds.has(id)) || mapping.evidence.sourceRefs.some(ref => !safePath(ref.path))) throw new Error("Invalid blueprint mapping reference");
  }
}

export function createModernizationPreview(feature: FeatureInvestigation, blueprint: ModernizationBlueprint): ModernizationPreview | null {
  validateBlueprint(feature, blueprint);
  if (feature.id !== "feature:promotion" || blueprint.target.id !== "nextjs-layered-v1") return null;
  const prefix = `preview:${feature.id.replace(/^feature:/, "")}:${blueprint.target.id}`;
  const spec = [
    { key: "session", name: "Academic session selector", role: "Choose a synthetic demonstration session.", blueprint: "form" },
    { key: "source", name: "Source class selector", role: "Filter the synthetic student roster by class.", blueprint: "form" },
    { key: "destination", name: "Destination class selector", role: "Choose a proposed destination for the simulation.", blueprint: "form" },
    { key: "roster", name: "Student selection table", role: "Select or deselect synthetic students.", blueprint: "page" },
    { key: "summary", name: "Selected-student summary", role: "Show the current demonstration batch.", blueprint: "page" },
    { key: "review", name: "Promotion review", role: "Present selections for local review before simulation.", blueprint: "service" },
    { key: "confirmation", name: "Confirmation simulation", role: "Display a local-only completion state.", blueprint: "api" },
    { key: "reset", name: "Demonstration reset", role: "Clear local selections and return to the initial screen.", blueprint: "page" },
  ];
  const components: PreviewComponent[] = spec.map(item => {
    const blueprintComponentId = `${blueprint.id}:${item.blueprint}`;
    if (!blueprint.proposedComponents.some(component => component.id === blueprintComponentId)) throw new Error("Missing preview blueprint component");
    const mappings = blueprint.mappings.filter(mapping => mapping.proposedComponentId === blueprintComponentId);
    const legacySourceRefs = [...new Map(mappings.flatMap(mapping => mapping.evidence.sourceRefs).map(ref => [`${ref.path}:${ref.startLine}-${ref.endLine}`, ref])).values()];
    const evidenceCertainty = mappings.some(mapping => mapping.evidence.certainty === "observed") ? "observed" : mappings.some(mapping => mapping.evidence.certainty === "inferred") ? "inferred" : mappings.length ? "name-match" : "none";
    return { id: `${prefix}:${item.key}`, name: item.name, responsibility: item.role, blueprintComponentId, legacyNodeIds: [...new Set(mappings.map(mapping => mapping.legacyNodeId))], legacySourceRefs, evidenceCertainty, verificationGaps: ["The proposed interaction pattern is not established by legacy graph evidence.", ...(mappings.length ? ["Review mapped source references to confirm actual legacy responsibilities."] : ["No direct legacy mapping exists for this proposed UI control."])], provenance: "proposed-ux-component" };
  });
  const id = (key: string) => `${prefix}:${key}`;
  const screens: PreviewScreen[] = [
    { id: id("select-screen"), title: "Select students", description: "Configure a demonstration batch using synthetic records.", componentIds: ["session", "source", "destination", "roster", "summary", "reset"].map(id) },
    { id: id("review-screen"), title: "Review proposal", description: "Review the local simulation before confirming it.", componentIds: [id("review"), id("summary")] },
    { id: id("confirmation-screen"), title: "Simulation complete", description: "No real records are changed.", componentIds: [id("confirmation"), id("reset")] },
  ];
  const interactions: PreviewInteraction[] = [
    { id: id("change-session"), label: "Change demo session", componentId: id("session"), effect: "Clear selection and update the demonstration context.", provenance: "demonstration-only" },
    { id: id("change-class"), label: "Change demo classes", componentId: id("source"), effect: "Filter the synthetic roster and clear selection when source changes.", provenance: "demonstration-only" },
    { id: id("select-student"), label: "Select synthetic students", componentId: id("roster"), effect: "Update the local demonstration batch.", provenance: "demonstration-only" },
    { id: id("review-batch"), label: "Review batch", componentId: id("review"), effect: "Check demonstration-only selections and open review.", provenance: "demonstration-only" },
    { id: id("confirm-simulation"), label: "Simulate confirmation", componentId: id("confirmation"), effect: "Show a local completion state without a write or request.", provenance: "demonstration-only" },
    { id: id("reset-demo"), label: "Reset demonstration", componentId: id("reset"), effect: "Clear browser-local demonstration state.", provenance: "demonstration-only" },
  ];
  return { id: prefix, sourceFeatureId: feature.id, blueprintId: blueprint.id, sourceSnapshotId: blueprint.sourceSnapshotId, screens, components, interactions, syntheticData: PROMOTION_DEMO_DATA, assumptions: ["This interface is a proposed UX demonstration; the legacy application may work differently.", "Student names, sessions, classes, and identifiers are synthetic."], unresolvedQuestions: [...feature.unresolvedQuestions, ...blueprint.unresolvedDecisions], provenance: "deterministic-preview-template-v1" };
}
