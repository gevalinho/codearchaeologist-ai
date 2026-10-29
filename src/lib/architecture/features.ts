import type { Edge, Graph, Node, SourceRef } from "../archaeology/scanner";
import { safePath } from "./graph";

export type EvidenceType = "graph-node" | "graph-edge" | "name-match" | "operator-note";
export type FeatureClaim = { text: string; evidenceType: EvidenceType; nodeIds: string[]; edgeIds: string[]; sourceRefs: SourceRef[]; certainty: "observed" | "inferred" | "unverified" };
export type FeatureComponent = { node: Node; association: "anchor" | "relationship" | "name-match"; viaEdgeIds: string[] };
export type FeatureInvestigation = {
  id: string; title: string; description: FeatureClaim; components: FeatureComponent[];
  relationships: Edge[]; sourceRefs: SourceRef[]; explanation: FeatureClaim[];
  businessRules: FeatureClaim[]; operatorNotes: FeatureClaim[]; unresolvedQuestions: string[];
  coverageLimitations: string[]; missingComponents: string[]; nextInspection: string[];
  readiness: { status: "needs-source-review" | "partial-map"; observedEdges: number; inferredEdges: number; unresolvedCount: number };
};

const stop = new Set(["application", "controllers", "models", "assets", "main", "index", "php", "js", "get", "put", "data", "ctrl", "controller", "model", "method", "class", "classes", "file", "table", "result", "session", "student", "school", "service", "factory", "module", "input", "output", "update", "create", "delete", "list", "view", "all", "info", "reg", "gett"]);
const label = (term: string) => term.charAt(0).toUpperCase() + term.slice(1);
const usable = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 500;
const validRef = (value: unknown): value is SourceRef => !!value && typeof value === "object" && safePath((value as SourceRef).path) && Number.isSafeInteger((value as SourceRef).startLine) && Number.isSafeInteger((value as SourceRef).endLine) && (value as SourceRef).startLine > 0 && (value as SourceRef).endLine >= (value as SourceRef).startLine;
const validNode = (node: Node) => usable(node.id) && usable(node.name) && validRef(node.source);
const validEdge = (edge: Edge, ids: Set<string>) => usable(edge.id) && usable(edge.kind) && ids.has(edge.from) && ids.has(edge.to) && validRef(edge.source) && (edge.certainty === "observed" || edge.certainty === "inferred");
const uniqueRefs = (refs: SourceRef[]) => [...new Map(refs.map(ref => [`${ref.path}:${ref.startLine}-${ref.endLine}`, ref])).values()].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);

export function featureTerms(name: string): string[] {
  return [...new Set(name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase().split(/\s+/).filter(part => part.length >= 4 && !stop.has(part)))];
}

type FeatureSpec = { term: string; title?: string; preferredNames?: string[]; operatorNotes?: string[] };
export function investigateFeature(graph: Graph, spec: FeatureSpec): FeatureInvestigation {
  const term = spec.term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!term || term.length > 80) throw new Error("Invalid feature term");
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter(validNode).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ids = new Set(byId.keys());
  const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter(edge => validEdge(edge, ids)).sort((a, b) => a.id.localeCompare(b.id));
  const anchors = nodes.filter(node => featureTerms(node.name).includes(term) && node.kind !== "file" && node.kind !== "branch");
  const anchorIds = new Set(anchors.map(node => node.id));
  const direct = edges.filter(edge => anchorIds.has(edge.from) || anchorIds.has(edge.to));
  const relatedIds = new Set(direct.flatMap(edge => [edge.from, edge.to]));
  const preferred = spec.preferredNames ?? [];
  const namedIds = new Set(nodes.filter(node => preferred.some(name => node.name.toLowerCase().includes(name.toLowerCase()))).map(node => node.id));
  const included = nodes.filter(node => anchorIds.has(node.id) || relatedIds.has(node.id) || namedIds.has(node.id));
  const includedIds = new Set(included.map(node => node.id));
  const relationships = edges.filter(edge => includedIds.has(edge.from) && includedIds.has(edge.to) && (anchorIds.has(edge.from) || anchorIds.has(edge.to)));
  const components: FeatureComponent[] = included.map(node => ({ node, association: anchorIds.has(node.id) ? "anchor" : relatedIds.has(node.id) ? "relationship" : "name-match", viaEdgeIds: relationships.filter(edge => edge.from === node.id || edge.to === node.id).map(edge => edge.id) }));
  const sourceRefs = uniqueRefs([...included.map(node => node.source), ...relationships.map(edge => edge.source)]);
  const observed = relationships.filter(edge => edge.certainty === "observed"), inferred = relationships.filter(edge => edge.certainty === "inferred");
  const claim = (text: string, evidenceType: EvidenceType, claimNodes: Node[] = [], claimEdges: Edge[] = [], certainty: FeatureClaim["certainty"] = "unverified"): FeatureClaim => ({ text, evidenceType, nodeIds: claimNodes.map(node => node.id), edgeIds: claimEdges.map(edge => edge.id), sourceRefs: uniqueRefs([...claimNodes.map(node => node.source), ...claimEdges.map(edge => edge.source)]), certainty });
  const title = spec.title ?? `${label(term)} candidate`;
  const description = claim(`${title} appears in ${anchors.length} matching architecture component${anchors.length === 1 ? "" : "s"}. This is a name-based feature candidate.`, "name-match", anchors);
  const explanation: FeatureClaim[] = [description];
  if (observed.length) explanation.push(claim(`${observed.length} directly extracted relationship${observed.length === 1 ? "" : "s"} connect participating components. Each edge identifies its source pattern and location.`, "graph-edge", [], observed, "observed"));
  if (inferred.length) explanation.push(claim(`${inferred.length} relationship${inferred.length === 1 ? "" : "s"} require source review.`, "graph-edge", [], inferred, "inferred"));
  const namingOnly = components.filter(component => component.association === "name-match").map(component => component.node);
  if (namingOnly.length) explanation.push(claim(`${namingOnly.length} additional component${namingOnly.length === 1 ? "" : "s"} match the investigation names without a direct feature edge.`, "name-match", namingOnly));
  const guardEdges = relationships.filter(edge => edge.kind === "guards");
  const businessRules = guardEdges.map(edge => claim(`A guard pattern is attached to ${byId.get(edge.from)?.name ?? "a component"}; the condition and runtime behavior need source review.`, "graph-edge", [], [edge], edge.certainty));
  const operatorNotes = (spec.operatorNotes ?? []).map(text => claim(text, "operator-note"));
  const missingComponents = preferred.filter(name => !nodes.some(node => node.name.toLowerCase().includes(name.toLowerCase())));
  const unresolvedQuestions = ["What do the referenced method bodies and guard conditions actually enforce?", "Do route aliases or dynamic calls connect components that this graph does not link?", "What behavior is confirmed by tests or runtime observation?"];
  if (namingOnly.length) unresolvedQuestions.push("How do the name-matched components connect to the observed workflow?");
  const coverageLimitations = ["The scanner extracts source patterns, not complete PHP or JavaScript semantics.", "Names and domain labels suggest relevance; they do not prove behavior or reachability.", "Missing edges do not prove that dependencies are absent."];
  if (graph.sourceCoverage?.partial) coverageLimitations.push("Partial source analysis: omitted files may contain additional components, relationships, or features.");
  if (missingComponents.length) coverageLimitations.push(`${missingComponents.length} expected component name${missingComponents.length === 1 ? " is" : "s are"} absent from this snapshot.`);
  const nextInspection = ["Open the cited method bodies and confirm the conditions, writes, and route mappings in source.", "Check tests or runtime traces before treating business behavior as verified."];
  if (inferred.length) nextInspection.unshift("Resolve inferred relationships at their cited call sites.");
  return { id: `feature:${term}`, title, description, components, relationships, sourceRefs, explanation, businessRules, operatorNotes, unresolvedQuestions, coverageLimitations, missingComponents, nextInspection, readiness: { status: observed.length && !missingComponents.length ? "partial-map" : "needs-source-review", observedEdges: observed.length, inferredEdges: inferred.length, unresolvedCount: unresolvedQuestions.length } };
}

const promotionNotes = ["Operator note awaiting source verification: active-session checks and destination-class requirements were reported in the inspected legacy source.", "Operator note awaiting source verification: session-date comparison and class-membership updates were reported.", "Operator note awaiting source verification: score entry reportedly limits continuous assessment to 40 and examination score to 60; this is separate from promotion unless an explicit edge establishes a link."];
export function studentPromotionFeature(graph: Graph): FeatureInvestigation {
  return investigateFeature(graph, { term: "promotion", title: "Student Promotion", preferredNames: ["promotionCtr", "putPromotion", "getPromotion", "putScore", "getCollatedResultinput", "classes", "session", "result"], operatorNotes: promotionNotes });
}

export function discoverFeatures(graph: Graph, limit = 24): FeatureInvestigation[] {
  const counts = new Map<string, number>();
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (!validNode(node) || node.kind === "file" || node.kind === "branch" || node.kind === "table") continue;
    for (const term of featureTerms(node.name)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const terms = [...counts].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.max(0, Math.min(limit, 50))).map(([term]) => term);
  const features = terms.map(term => term === "promotion" ? studentPromotionFeature(graph) : investigateFeature(graph, { term }));
  if (!features.some(feature => feature.id === "feature:promotion") && Array.isArray(graph.nodes) && graph.nodes.some(node => validNode(node) && featureTerms(node.name).includes("promotion"))) features.unshift(studentPromotionFeature(graph));
  return features;
}
