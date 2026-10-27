import type { SourceRef } from "../archaeology/scanner";
import type { FeatureInvestigation } from "./features";
import { rankFeatureComponents } from "./relevance";

export type TargetArchitecture = { id: string; title: string; frontend: string; backend: string; status: "proposed" };
export type ProposedComponent = { id: string; title: string; responsibility: string; layer: "frontend" | "api" | "application" | "domain" | "data"; provenance: "modernization-recommendation" };
export type LegacyModernMapping = { legacyNodeId: string; proposedComponentId: string; rationale: string; evidence: { sourceRefs: SourceRef[]; graphEdgeIds: string[]; certainty: "observed" | "inferred" | "name-match" }; provenance: "design-recommendation" };
export type ModernizationBlueprint = { id: string; sourceFeatureId: string; sourceSnapshotId: string; target: TargetArchitecture; proposedComponents: ProposedComponent[]; proposedFlow: string[]; mappings: LegacyModernMapping[]; supportingSourceEvidence: SourceRef[]; assumptions: string[]; unresolvedDecisions: string[]; verificationRequirements: string[]; recommendationProvenance: "deterministic-template-v1" };

export const NEXT_LAYERED: TargetArchitecture = { id: "nextjs-layered-v1", title: "React / Next.js with a layered backend", frontend: "React / Next.js", backend: "Layered API, application, domain, and data access", status: "proposed" };

export function buildModernizationBlueprint(feature: FeatureInvestigation, snapshotId: string, target: TargetArchitecture = NEXT_LAYERED): ModernizationBlueprint {
  const prefix = `proposal:${feature.id.replace(/^feature:/, "")}:${target.id}`;
  const proposedComponents: ProposedComponent[] = [
    { id: `${prefix}:page`, title: "Feature page", responsibility: "Present the feature and its current state to the user.", layer: "frontend", provenance: "modernization-recommendation" },
    { id: `${prefix}:form`, title: "Feature form", responsibility: "Collect and submit user intent with clear feedback.", layer: "frontend", provenance: "modernization-recommendation" },
    { id: `${prefix}:api`, title: "Feature API", responsibility: "Accept requests and return explicit outcomes.", layer: "api", provenance: "modernization-recommendation" },
    { id: `${prefix}:service`, title: "Application service", responsibility: "Coordinate the confirmed workflow and its dependencies.", layer: "application", provenance: "modernization-recommendation" },
    { id: `${prefix}:validation`, title: "Validation boundary", responsibility: "Apply business rules only after they are verified from source and tests.", layer: "domain", provenance: "modernization-recommendation" },
    { id: `${prefix}:repository`, title: "Data access repository", responsibility: "Isolate persistence operations behind an explicit interface.", layer: "data", provenance: "modernization-recommendation" },
    { id: `${prefix}:entities`, title: "Domain data", responsibility: "Model confirmed entities and their relationships.", layer: "domain", provenance: "modernization-recommendation" },
  ];
  const ranked = rankFeatureComponents(feature);
  const mappings: LegacyModernMapping[] = ranked.flatMap(item => {
    const node = item.node;
    let destination: string | undefined;
    if (node.kind === "endpoint") destination = "api";
    else if (node.kind === "controller") destination = node.source.path.toLowerCase().endsWith(".js") ? "page" : "api";
    else if (node.kind === "method") destination = /\/models\//i.test(node.source.path) ? "repository" : "service";
    else if (node.kind === "table") destination = "entities";
    else if (node.kind === "branch") destination = "validation";
    if (!destination) return [];
    const edges = feature.relationships.filter(edge => item.evidenceEdgeIds.includes(edge.id));
    return [{ legacyNodeId: node.id, proposedComponentId: `${prefix}:${destination}`, rationale: `Candidate placement based on ${node.kind} metadata; responsibility and behavior require source review.`, evidence: { sourceRefs: [node.source, ...edges.map(edge => edge.source)], graphEdgeIds: edges.map(edge => edge.id), certainty: edges.some(edge => edge.certainty === "observed") ? "observed" as const : edges.some(edge => edge.certainty === "inferred") ? "inferred" as const : "name-match" as const }, provenance: "design-recommendation" as const }];
  });
  return {
    id: prefix, sourceFeatureId: feature.id, sourceSnapshotId: snapshotId, target, proposedComponents,
    proposedFlow: ["page", "form", "api", "service", "validation", "repository", "entities"].map(id => `${prefix}:${id}`),
    mappings, supportingSourceEvidence: feature.sourceRefs,
    assumptions: ["This is a conceptual design based on architecture metadata, not a verified execution trace.", "Component roles are proposed boundaries, not confirmed legacy responsibilities."],
    unresolvedDecisions: ["Confirm feature behavior and eligibility rules in source and tests.", "Choose API contracts, authorization, transaction boundaries, and persistence model after review."],
    verificationRequirements: ["Review source at every cited mapping reference.", "Confirm rules with tests or observed runtime behavior before implementation.", "Validate the proposed data model and API contract with maintainers."],
    recommendationProvenance: "deterministic-template-v1",
  };
}
