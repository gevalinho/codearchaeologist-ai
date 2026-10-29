import type { Graph, SourceCoverage, SourceRef } from "../archaeology/scanner";
import { safePath, validSourceCoverage } from "./graph";
import type { FeatureInvestigation } from "./features";
import type { ReconstructionPlan } from "./reconstruction-planner";

export type EvidenceOrigin = "browser-local" | "public-github" | "private-github" | "imported-graph";
export type PacketItem = { id: string; kind: "component" | "relationship" | "rule"; label: string; certainty: "observed" | "inferred"; source: SourceRef };
export type EvidencePacket = { schemaVersion: "1.0.0"; featureId: string; featureTitle: string; snapshotId: string; origin: EvidenceOrigin; classification: string; sourceAvailability: "references-only"; excerpts: []; items: PacketItem[]; limitations: string[]; deterministicProposal: { id: string; fields: string[]; uncertainty: string[] } | null; sourceCoverage?: SourceCoverage };

const SENSITIVE = /(?:^|[/_.-])(?:\.env|secrets?|tokens?|credentials?|passwords?|private[_-]?keys?|api[_-]?keys?)(?:$|[/_.-])/i;
const safeLabel = (value: unknown, max = 160): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value) && !SENSITIVE.test(value);
export const safeAiLabel = (value: unknown, max = 160): value is string => safeLabel(value, max);
export const safeAiSourceRef = (value: unknown): value is SourceRef => validRef(value);
const validRef = (value: unknown): value is SourceRef => !!value && typeof value === "object" && safePath((value as SourceRef).path) && (!SENSITIVE.test((value as SourceRef).path) || /^(?:application\/controllers?|app\/Http\/Controllers)\/Password\.php$/.test((value as SourceRef).path)) && Number.isSafeInteger((value as SourceRef).startLine) && Number.isSafeInteger((value as SourceRef).endLine) && (value as SourceRef).startLine > 0 && (value as SourceRef).endLine >= (value as SourceRef).startLine && (value as SourceRef).endLine - (value as SourceRef).startLine <= 20;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => name in value);
const origins: EvidenceOrigin[] = ["browser-local", "public-github", "private-github", "imported-graph"];
const classifications = ["business-workflow", "technical-controller", "shared-utility", "data-access", "uncertain"];
const ruleLabels: Record<string, string> = { validation: "Input validation pattern", authorization: "Access condition pattern", condition: "Comparison branch pattern", "state-transition": "State assignment pattern", calculation: "Arithmetic assignment pattern" };

/** Graph artifacts contain references, not source bodies. Never reconstruct excerpts from names or paths. */
export function createEvidencePacket(graph: Graph, feature: FeatureInvestigation, plan: ReconstructionPlan, origin: EvidenceOrigin): EvidencePacket {
  const items: PacketItem[] = [];
  const components = [...feature.components].sort((a, b) => a.node.id.localeCompare(b.node.id));
  const edges = [...feature.relationships].sort((a, b) => a.id.localeCompare(b.id));
  const rules = (graph.rules ?? []).filter(rule => plan.classification.ruleIds.includes(rule.id)).sort((a, b) => a.id.localeCompare(b.id));
  for (const component of components.slice(0, 12)) if (safeLabel(component.node.name) && validRef(component.node.source)) items.push({ id: `n${items.length + 1}`, kind: "component", label: `${component.node.kind}: ${component.node.name}`, certainty: component.node.certainty, source: component.node.source });
  for (const edge of edges.slice(0, 16)) if (safeLabel(edge.kind) && validRef(edge.source)) items.push({ id: `e${items.length + 1}`, kind: "relationship", label: edge.kind, certainty: edge.certainty, source: edge.source });
  for (const rule of rules.slice(0, 12)) if (ruleLabels[rule.kind] && validRef(rule.source)) items.push({ id: `r${items.length + 1}`, kind: "rule", label: ruleLabels[rule.kind], certainty: "observed", source: rule.source });
  const proposal = plan.status === "available" ? { id: plan.spec.id, fields: plan.spec.screens[0].fields.map(field => field.label).slice(0, 12), uncertainty: plan.spec.uncertainty.slice(0, 4).map(item => item.slice(0, 160)) } : null;
  const packet: EvidencePacket = { schemaVersion: "1.0.0", featureId: feature.id, featureTitle: feature.title.slice(0, 160), snapshotId: graph.snapshotId, origin, classification: plan.classification.category, sourceAvailability: "references-only", excerpts: [], items, limitations: ["Source bodies and excerpts are unavailable in this graph artifact.", "Static patterns and inferred relationships do not verify runtime behavior.", ...(graph.sourceCoverage?.partial ? ["Partial source analysis: omitted files may contain missing components or relationships."] : []), ...(components.length > 12 || edges.length > 16 || rules.length > 12 ? ["The evidence packet is a bounded subset of this candidate."] : [])], deterministicProposal: proposal, ...(graph.sourceCoverage ? { sourceCoverage: graph.sourceCoverage } : {}) };
  return parseEvidencePacket(packet);
}

export function parseEvidencePacket(value: unknown): EvidencePacket {
  if (!record(value) || !exact(value, ["schemaVersion", "featureId", "featureTitle", "snapshotId", "origin", "classification", "sourceAvailability", "excerpts", "items", "limitations", "deterministicProposal", ...(value.sourceCoverage === undefined ? [] : ["sourceCoverage"])]) || value.schemaVersion !== "1.0.0" || !safeLabel(value.featureId) || !safeLabel(value.featureTitle) || !safeLabel(value.snapshotId, 128) || !origins.includes(value.origin as EvidenceOrigin) || !classifications.includes(value.classification as string) || value.sourceAvailability !== "references-only" || !Array.isArray(value.excerpts) || value.excerpts.length !== 0 || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 40 || !Array.isArray(value.limitations) || value.limitations.length < 2 || value.limitations.length > 4 || !value.limitations.every(item => safeLabel(item, 180)) || value.sourceCoverage !== undefined && !validSourceCoverage(value.sourceCoverage)) throw new Error("Invalid evidence packet.");
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || !exact(item, ["id", "kind", "label", "certainty", "source"]) || !safeLabel(item.id, 12) || ids.has(item.id as string) || !["component", "relationship", "rule"].includes(item.kind as string) || !safeLabel(item.label) || !["observed", "inferred"].includes(item.certainty as string) || item.kind === "rule" && item.certainty !== "observed" || !validRef(item.source)) throw new Error("Invalid evidence packet.");
    ids.add(item.id as string);
  }
  if (value.deterministicProposal !== null) {
    const proposal = value.deterministicProposal;
    if (!record(proposal) || !exact(proposal, ["id", "fields", "uncertainty"]) || !safeLabel(proposal.id) || !Array.isArray(proposal.fields) || proposal.fields.length > 12 || !proposal.fields.every(item => safeLabel(item)) || !Array.isArray(proposal.uncertainty) || proposal.uncertainty.length > 4 || !proposal.uncertainty.every(item => safeLabel(item))) throw new Error("Invalid evidence packet.");
  }
  if (JSON.stringify(value).length > 16_000) throw new Error("Evidence packet exceeds the 16 KB limit.");
  return value as EvidencePacket;
}
