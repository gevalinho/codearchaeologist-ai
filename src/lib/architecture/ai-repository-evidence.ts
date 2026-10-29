import type { Graph, SourceCoverage, SourceRef } from "../archaeology/scanner";
import type { EvidenceOrigin, PacketItem } from "./ai-evidence";
import { safeAiLabel, safeAiSourceRef } from "./ai-evidence";
import type { FeatureInvestigation } from "./features";
import { classifyFeature, type FeatureCategory } from "./feature-classification";
import { validSourceCoverage } from "./graph";

export type RepositoryEvidencePacket = {
  schemaVersion: "1.0.0"; scope: "repository"; snapshotId: string; origin: EvidenceOrigin;
  sourceAvailability: "references-only"; excerpts: [];
  candidates: { id: string; title: string; classification: FeatureCategory; evidenceId: string }[];
  indicators: { language: "PHP" | "JavaScript"; evidenceId: string }[];
  items: PacketItem[];
  coverage: { candidateGroupsFound: number; candidateGroupsRepresented: number; referencesRepresented: number; analyzedFiles: number; omittedCandidateGroups: number; truncated: boolean };
  sourceCoverage?: SourceCoverage;
  limitations: string[];
};

const originValues = ["browser-local", "public-github", "private-github", "imported-graph"];
const exact = (value: Record<string, unknown>, names: string[]) => Object.keys(value).sort().join() === [...names].sort().join();
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const generic = /^(?:core|common|base|index|main|helper|utility|app|application|system|default)\s+candidate$/i;
const refKey = (ref: SourceRef) => `${ref.path}:${ref.startLine}`;
const lineRef = (ref: SourceRef): SourceRef => ({ path: ref.path, startLine: ref.startLine, endLine: ref.startLine });

/** A small, representative snapshot of graph metadata. No source bodies are read here. */
export function createRepositoryEvidencePacket(graph: Graph, features: FeatureInvestigation[], origin: EvidenceOrigin): RepositoryEvidencePacket {
  const items: PacketItem[] = [], candidates: RepositoryEvidencePacket["candidates"] = [], indicators: RepositoryEvidencePacket["indicators"] = [];
  const seen = new Set<string>();
  const add = (kind: PacketItem["kind"], label: string, certainty: PacketItem["certainty"], source: SourceRef): string | null => {
    const ref = lineRef(source), key = refKey(ref);
    if (!safeAiLabel(label) || !safeAiSourceRef(ref) || seen.has(key) || items.length >= 40) return null;
    const id = `r${items.length + 1}`;
    items.push({ id, kind, label, certainty, source: ref });
    if (JSON.stringify(items).length > 11_000) { items.pop(); return null; }
    seen.add(key);
    return id;
  };
  const ranked = [...features].sort((a, b) => Number(generic.test(a.title)) - Number(generic.test(b.title)) || (b.readiness.observedEdges - a.readiness.observedEdges) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  for (const feature of ranked) {
    if (candidates.length >= 10) break;
    const anchors = feature.components.filter(part => part.association === "anchor" && part.node.kind !== "file").sort((a, b) => a.node.source.path.localeCompare(b.node.source.path) || a.node.source.startLine - b.node.source.startLine || a.node.id.localeCompare(b.node.id));
    for (const anchor of anchors) {
      const evidenceId = add("component", `${anchor.node.kind}: ${anchor.node.name}`, anchor.node.certainty, anchor.node.source);
      if (evidenceId) { candidates.push({ id: feature.id, title: feature.title, classification: classifyFeature(graph, feature).category, evidenceId }); break; }
    }
  }
  // Round-robin across candidates, so one dense feature cannot fill the packet.
  const byFeature = candidates.map(candidate => features.find(feature => feature.id === candidate.id)!);
  for (let pass = 0; pass < 3 && items.length < 36; pass++) for (const feature of byFeature) {
    const component = feature.components.filter(part => part.association !== "anchor" && part.node.kind !== "file").sort((a, b) => a.node.id.localeCompare(b.node.id))[pass];
    if (component) add("component", `${component.node.kind}: ${component.node.name}`, component.node.certainty, component.node.source);
    const edge = [...feature.relationships].sort((a, b) => a.id.localeCompare(b.id))[pass];
    if (edge) add("relationship", edge.kind, edge.certainty, edge.source);
  }
  const labels: Record<string, string> = { validation: "Input validation pattern", authorization: "Access condition pattern", condition: "Comparison branch pattern", "state-transition": "State assignment pattern", calculation: "Arithmetic assignment pattern" };
  for (const rule of [...(graph.rules ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))) {
    if (items.length >= 38) break;
    add("rule", labels[rule.kind], "observed", rule.source);
  }
  for (const language of ["PHP", "JavaScript"] as const) {
    const suffix = language === "PHP" ? ".php" : ".js";
    const file = [...graph.nodes].filter(node => node.kind === "file" && node.source.path.toLowerCase().endsWith(suffix)).sort((a, b) => a.source.path.localeCompare(b.source.path))[0];
    if (file) { const evidenceId = add("component", `${language} source file`, "observed", file.source); if (evidenceId) indicators.push({ language, evidenceId }); }
  }
  const omitted = Math.max(0, features.length - candidates.length);
  const packet: RepositoryEvidencePacket = { schemaVersion: "1.0.0", scope: "repository", snapshotId: graph.snapshotId, origin, sourceAvailability: "references-only", excerpts: [], candidates, indicators, items, coverage: { candidateGroupsFound: features.length, candidateGroupsRepresented: candidates.length, referencesRepresented: items.length, analyzedFiles: graph.scan.fileCount, omittedCandidateGroups: omitted, truncated: omitted > 0 || graph.nodes.length + graph.edges.length + (graph.rules?.length ?? 0) > items.length }, ...(graph.sourceCoverage ? { sourceCoverage: graph.sourceCoverage } : {}), limitations: ["Name-based candidates are not verified working features.", "Static graph metadata does not verify repository purpose or runtime behavior.", "Only representative references are sent; source bodies and excerpts are excluded.", ...(graph.sourceCoverage?.partial ? ["Partial source analysis: omitted files may contain missing features or relationships."] : [])] };
  return parseRepositoryEvidencePacket(packet);
}

export function parseRepositoryEvidencePacket(value: unknown): RepositoryEvidencePacket {
  if (!record(value) || !exact(value, ["schemaVersion", "scope", "snapshotId", "origin", "sourceAvailability", "excerpts", "candidates", "indicators", "items", "coverage", "limitations", ...(value.sourceCoverage === undefined ? [] : ["sourceCoverage"])]) || value.schemaVersion !== "1.0.0" || value.scope !== "repository" || !safeAiLabel(value.snapshotId, 128) || !originValues.includes(value.origin as string) || value.sourceAvailability !== "references-only" || !Array.isArray(value.excerpts) || value.excerpts.length !== 0 || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 40 || !Array.isArray(value.candidates) || value.candidates.length > 10 || !Array.isArray(value.indicators) || value.indicators.length > 2 || !Array.isArray(value.limitations) || value.limitations.length < 2 || value.limitations.length > 4 || !value.limitations.every(item => safeAiLabel(item, 180)) || value.sourceCoverage !== undefined && !validSourceCoverage(value.sourceCoverage)) throw new Error("Invalid repository evidence packet.");
  const ids = new Set<string>(), refs = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || !exact(item, ["id", "kind", "label", "certainty", "source"]) || !safeAiLabel(item.id, 12) || ids.has(item.id as string) || !["component", "relationship", "rule"].includes(item.kind as string) || !safeAiLabel(item.label) || !["observed", "inferred"].includes(item.certainty as string) || item.kind === "rule" && item.certainty !== "observed" || !safeAiSourceRef(item.source) || refs.has(refKey(item.source as SourceRef))) throw new Error("Invalid repository evidence packet.");
    ids.add(item.id as string); refs.add(refKey(item.source as SourceRef));
  }
  const candidateIds = new Set<string>(), candidateEvidence = new Set<string>();
  for (const candidate of value.candidates) {
    const anchor = (value.items as PacketItem[]).find(item => item.id === candidate?.evidenceId);
    if (!record(candidate) || !exact(candidate, ["id", "title", "classification", "evidenceId"]) || !safeAiLabel(candidate.id) || candidateIds.has(candidate.id as string) || !safeAiLabel(candidate.title) || !["business-workflow", "technical-controller", "shared-utility", "data-access", "uncertain"].includes(candidate.classification as string) || !ids.has(candidate.evidenceId as string) || candidateEvidence.has(candidate.evidenceId as string) || !String(candidate.title).toLowerCase().includes(String(candidate.id).replace(/^feature:/, "").toLowerCase()) || anchor?.kind !== "component" || !anchor.label.toLowerCase().includes(String(candidate.id).replace(/^feature:/, "").toLowerCase())) throw new Error("Invalid repository candidates.");
    candidateIds.add(candidate.id as string); candidateEvidence.add(candidate.evidenceId as string);
  }
  for (const indicator of value.indicators) if (!record(indicator) || !exact(indicator, ["language", "evidenceId"]) || !["PHP", "JavaScript"].includes(indicator.language as string) || !ids.has(indicator.evidenceId as string)) throw new Error("Invalid language indicator.");
  const coverage = value.coverage;
  if (!record(coverage) || !exact(coverage, ["candidateGroupsFound", "candidateGroupsRepresented", "referencesRepresented", "analyzedFiles", "omittedCandidateGroups", "truncated"]) || ![coverage.candidateGroupsFound, coverage.candidateGroupsRepresented, coverage.referencesRepresented, coverage.analyzedFiles, coverage.omittedCandidateGroups].every(number => Number.isSafeInteger(number) && (number as number) >= 0) || coverage.candidateGroupsRepresented !== value.candidates.length || coverage.referencesRepresented !== value.items.length || coverage.candidateGroupsFound !== (coverage.candidateGroupsRepresented as number) + (coverage.omittedCandidateGroups as number) || typeof coverage.truncated !== "boolean" || (coverage.omittedCandidateGroups as number) > 0 && !coverage.truncated) throw new Error("Invalid repository coverage.");
  if (JSON.stringify(value).length > 16_000) throw new Error("Repository evidence packet exceeds the 16 KB limit.");
  return value as RepositoryEvidencePacket;
}
