import type { FeatureComponent, FeatureInvestigation } from "./features";
import type { Edge } from "../archaeology/scanner";

export type RelevanceTier = "core" | "supporting" | "related";
export type RankedComponent = FeatureComponent & { tier: RelevanceTier; reason: string; score: number; evidenceEdgeIds: string[] };
const coreKinds = new Set(["controller", "method", "endpoint", "service", "factory"]);

export function rankFeatureComponents(feature: FeatureInvestigation): RankedComponent[] {
  const edges = new Map(feature.relationships.map(edge => [edge.id, edge]));
  const components = new Map(feature.components.map(component => [component.node.id, component]));
  return feature.components.map(component => {
    const connected = component.viaEdgeIds.map(id => edges.get(id)).filter((edge): edge is Edge => !!edge);
    const observed = connected.filter(edge => edge.certainty === "observed");
    const shared = component.node.domain === "shared-infrastructure";
    const directEntry = (component.node.kind === "endpoint" || component.node.kind === "controller") && observed.some(edge => components.get(edge.from === component.node.id ? edge.to : edge.from)?.association === "anchor");
    let tier: RelevanceTier, reason: string, score: number;
    if (((component.association === "anchor" && coreKinds.has(component.node.kind)) || directEntry) && observed.length && !shared) {
      tier = "core"; score = 300 + observed.length * 10 + (component.node.kind === "controller" || component.node.kind === "endpoint" ? 5 : 0);
      reason = directEntry && component.association !== "anchor" ? `An observed graph relationship connects this ${component.node.kind} to a feature-named entry point.` : `Feature name matches this ${component.node.kind}; ${observed.length} observed graph relationship${observed.length === 1 ? "" : "s"} provide architectural evidence.`;
    } else if (connected.length && (component.association === "relationship" || shared || component.association === "anchor")) {
      tier = "supporting"; score = 200 + observed.length * 10 + connected.length;
      reason = shared ? "Shared infrastructure is connected by recorded graph relationships; its role in this workflow still needs review." : component.association === "anchor" ? "Feature name matches and recorded relationships exist, but core execution relevance is unresolved." : "Connected to a feature component through recorded graph relationships; execution relevance needs review.";
    } else {
      tier = "related"; score = 100 + (component.association === "anchor" ? 10 : 0);
      reason = component.association === "anchor" ? "Feature name matches, but no qualifying observed relationship establishes a core role." : "Associated by a name pattern or investigation term; no direct feature relationship was recorded.";
    }
    return { ...component, tier, reason, score, evidenceEdgeIds: connected.map(edge => edge.id) };
  }).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
}

export function relevanceGroups(feature: FeatureInvestigation) {
  const ranked = rankFeatureComponents(feature);
  return { core: ranked.filter(item => item.tier === "core"), supporting: ranked.filter(item => item.tier === "supporting"), related: ranked.filter(item => item.tier === "related") };
}
