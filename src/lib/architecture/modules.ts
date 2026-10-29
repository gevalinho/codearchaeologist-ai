import type { Domain, Edge, Graph, Node, SourceRef } from "../archaeology/scanner";
import { discoverFeatures, type FeatureInvestigation } from "./features";

export type ModuleInvestigation = {
  id: string; displayName: string; boundaryCertainty: "candidate"; candidateDomain: Domain;
  memberNodeIds: string[]; featureCandidateIds: string[]; sourceRefs: SourceRef[];
  internalRelationships: Edge[]; crossModuleDependencies: Edge[];
  evidenceCounts: { observedNodes: number; inferredNodes: number; observedRelationships: number; inferredRelationships: number };
  classificationReasons: string[]; coverageLimitations: string[]; unresolvedQuestions: string[];
};
export type ModuleCoverage = { scannedFiles: number; totalComponents: number; assignedComponents: number; unclassifiedNodeIds: string[]; observedRelationships: number; inferredRelationships: number; warnings: string[]; limitations: string[] };
export type ModuleDiscovery = { modules: ModuleInvestigation[]; coverage: ModuleCoverage };

const compare = (a: string, b: string) => a.localeCompare(b);
const genericContainer = /^(?:get|put)data(?:c(?:t|r)?rl|controller|model)$/i;
const refs = (nodes: Node[], edges: Edge[]): SourceRef[] => [...new Map([...nodes.map(node => node.source), ...edges.map(edge => edge.source)].map(ref => [`${ref.path}:${ref.startLine}:${ref.endLine}`, ref])).values()].sort((a, b) => compare(a.path, b.path) || a.startLine - b.startLine || a.endLine - b.endLine);

export function discoverModules(graph: Graph, features: FeatureInvestigation[] = discoverFeatures(graph)): ModuleDiscovery {
  const nodes = [...graph.nodes].sort((a, b) => compare(a.id, b.id));
  const edges = [...graph.edges].sort((a, b) => compare(a.id, b.id));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const specs = [...features].filter(feature => !genericContainer.test(feature.id.replace(/^feature:/, ""))).sort((a, b) => compare(a.id, b.id)).map(feature => ({
    id: `module:${feature.id.replace(/^feature:/, "")}`, displayName: feature.title.replace(/ candidate$/i, ""),
    featureIds: [feature.id], anchors: feature.components.filter(component => component.association === "anchor").map(component => component.node.id),
    reason: `Named components match the ${feature.title} feature candidate; linked members come from recorded graph edges.`,
  }));
  const shared = nodes.filter(node => node.domain === "shared-infrastructure" && node.kind !== "file" && node.kind !== "branch");
  if (shared.length) specs.push({ id: "module:shared-infrastructure", displayName: "Shared infrastructure", featureIds: [], anchors: shared.map(node => node.id), reason: "Scanner domain labels indicate shared infrastructure; this is a candidate grouping based on names." });
  const candidates = specs.map(spec => {
    const anchorIds = new Set(spec.anchors.filter(id => byId.has(id)));
    const ids = new Set(anchorIds);
    for (const edge of edges) {
      if (anchorIds.has(edge.from)) ids.add(edge.to);
      if (anchorIds.has(edge.to)) ids.add(edge.from);
    }
    const members = nodes.filter(node => ids.has(node.id));
    const internalRelationships = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
    const crossModuleDependencies = edges.filter(edge => ids.has(edge.from) !== ids.has(edge.to));
    const domainCounts = new Map<Domain, number>();
    for (const id of anchorIds) { const domain = byId.get(id)?.domain; if (domain && domain !== "unknown") domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1); }
    const candidateDomain = [...domainCounts].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0] ?? "unknown";
    return {
      id: spec.id, displayName: spec.displayName, boundaryCertainty: "candidate" as const, candidateDomain,
      memberNodeIds: members.map(node => node.id), featureCandidateIds: spec.featureIds,
      sourceRefs: refs(members, internalRelationships), internalRelationships, crossModuleDependencies,
      evidenceCounts: { observedNodes: members.filter(node => node.certainty === "observed").length, inferredNodes: members.filter(node => node.certainty === "inferred").length, observedRelationships: internalRelationships.filter(edge => edge.certainty === "observed").length, inferredRelationships: internalRelationships.filter(edge => edge.certainty === "inferred").length },
      classificationReasons: [spec.reason, `${anchorIds.size} name/domain anchors and ${members.length - anchorIds.size} directly connected components.`],
      coverageLimitations: ["Candidate boundaries use names and direct graph edges; shared files and tables can belong to several candidates.", ...graph.limitations],
      unresolvedQuestions: ["Which observed source paths confirm this boundary?", "Do dynamic routes or calls connect components missing from this graph?"],
    } satisfies ModuleInvestigation;
  }).filter(module => module.memberNodeIds.length).sort((a, b) => compare(a.id, b.id));
  const assigned = new Set(candidates.flatMap(module => module.memberNodeIds));
  const modules = candidates.map(module => ({ ...module, crossModuleDependencies: module.crossModuleDependencies.filter(edge => assigned.has(edge.from) && assigned.has(edge.to)) }));
  return { modules, coverage: {
    scannedFiles: graph.scan.fileCount, totalComponents: nodes.length, assignedComponents: assigned.size,
    unclassifiedNodeIds: nodes.filter(node => !assigned.has(node.id)).map(node => node.id),
    observedRelationships: edges.filter(edge => edge.certainty === "observed").length,
    inferredRelationships: edges.filter(edge => edge.certainty === "inferred").length,
    warnings: [...graph.warnings], limitations: [...graph.limitations],
  } };
}
