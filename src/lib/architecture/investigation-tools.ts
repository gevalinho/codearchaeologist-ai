import type { Graph, SourceRef } from "../archaeology/scanner";
import type { PacketItem } from "./ai-evidence";
import { safeAiLabel, safeAiSourceRef } from "./ai-evidence";
import { discoverFeatures } from "./features";

export const investigationToolNames = ["search_components", "trace_relationships", "inspect_rule_patterns", "find_feature_candidates", "check_coverage"] as const;
export type InvestigationToolName = typeof investigationToolNames[number];
export type InvestigationToolArgs = { query: string; componentId: string; depth: number };
export type InvestigationToolResult = { tool: InvestigationToolName; summary: string; items: Omit<PacketItem, "id">[]; matchCount?: number; coverage?: Graph["sourceCoverage"] | { analyzedFiles: number } };
const nameSet = new Set<string>(investigationToolNames);
export type InvestigationToolRule = "missing_fields" | "unexpected_fields" | "unknown_tool" | "query_type" | "query_limit" | "unsafe_query" | "component_id_type" | "component_id_limit" | "depth_type" | "depth_range" | "relationship_target" | "rule_target" | "search_query_required";
export class InvestigationToolValidationError extends Error {
  constructor(readonly rule: InvestigationToolRule) { super("Invalid investigation action."); this.name = "InvestigationToolValidationError"; }
}
const reject = (rule: InvestigationToolRule): never => { throw new InvestigationToolValidationError(rule); };
export function normalizeComponentSearch(query: string): string[] {
  return query.trim().replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(term => /^(?:authentication|authenticate|authenticated)$/.test(term) ? "auth" : term).slice(0, 8);
}
export function parseInvestigationToolCall(value: unknown, graph: Graph): { tool: InvestigationToolName; args: InvestigationToolArgs } {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("missing_fields");
  const action = value as Record<string, unknown>;
  const required = ["tool", "query", "componentId", "depth"];
  if (required.some(key => !(key in action))) reject("missing_fields");
  if (Object.keys(action).some(key => !required.includes(key))) reject("unexpected_fields");
  if (!nameSet.has(action.tool as string)) reject("unknown_tool");
  if (typeof action.query !== "string") reject("query_type");
  const query = action.query as string;
  if (query.length > 80) reject("query_limit");
  if (/[\u0000-\u001f\u007f<>]/.test(query)) reject("unsafe_query");
  if (typeof action.componentId !== "string") reject("component_id_type");
  const componentId = action.componentId as string;
  if (componentId.length > 500) reject("component_id_limit");
  if (!Number.isSafeInteger(action.depth)) reject("depth_type");
  if ((action.depth as number) < 0 || (action.depth as number) > 2) reject("depth_range");
  if (action.tool === "trace_relationships" && ((action.depth as number) < 1 || !graph.nodes.some(node => node.id === componentId))) reject("relationship_target");
  if (action.tool === "inspect_rule_patterns" && componentId && !graph.nodes.some(node => node.id === componentId)) reject("rule_target");
  if (action.tool === "search_components" && !query.trim()) reject("search_query_required");
  return { tool: action.tool as InvestigationToolName, args: { query, componentId, depth: action.depth as number } };
}
const item = (kind: PacketItem["kind"], label: string, certainty: PacketItem["certainty"], source: SourceRef): Omit<PacketItem, "id"> | null => safeAiLabel(label) && safeAiSourceRef(source) ? { kind, label, certainty, source: { path: source.path, startLine: source.startLine, endLine: source.startLine } } : null;
export function executeInvestigationTool(graph: Graph, tool: InvestigationToolName, args: InvestigationToolArgs): InvestigationToolResult {
  let items: Array<Omit<PacketItem, "id"> | null> = [];
  let summary = "";
  let searchMatchCount: number | undefined;
  if (tool === "search_components") {
    const terms = normalizeComponentSearch(args.query);
    const matches = graph.nodes.filter(node => {
      const indexed = `${node.id} ${node.name} ${node.kind} ${node.source.path}`.toLowerCase();
      return terms.every(term => indexed.includes(term));
    });
    searchMatchCount = matches.length;
    items = matches.slice(0, 12).map(node => item("component", `${node.id} · ${node.kind}: ${node.name}`, node.certainty, node.source));
    summary = matches.length ? `${matches.length} matching analyzed components; up to 12 references returned.` : "No analyzed components matched this query. Try a shorter related term or another read-only tool; omitted files were not searched.";
  } else if (tool === "trace_relationships") {
    const seen = new Set([args.componentId]);
    for (let hop = 0; hop < args.depth; hop++) {
      const frontier = new Set(seen);
      for (const edge of graph.edges) if (frontier.has(edge.from) || frontier.has(edge.to)) { seen.add(edge.from); seen.add(edge.to); }
    }
    const edges = graph.edges.filter(edge => seen.has(edge.from) && seen.has(edge.to));
    items = edges.slice(0, 12).map(edge => item("relationship", `${edge.kind}: ${edge.from} to ${edge.to}`, edge.certainty, edge.source));
    summary = `${edges.length} relationships within ${args.depth} graph hops; up to 12 references returned.`;
  } else if (tool === "inspect_rule_patterns") {
    const rules = (graph.rules ?? []).filter(rule => !args.componentId || rule.ownerNodeId === args.componentId);
    items = rules.slice(0, 12).map(rule => item("rule", `${rule.kind} pattern in ${rule.ownerNodeId}`, "observed", rule.source));
    summary = `${rules.length} static rule patterns; up to 12 references returned.`;
  } else if (tool === "find_feature_candidates") {
    const candidates = discoverFeatures(graph);
    items = candidates.slice(0, 12).map(feature => { const anchor = feature.components.find(part => part.association === "anchor"); return anchor ? item("component", `Hypothesis: ${feature.title}; ${anchor.node.id} · ${anchor.node.kind}: ${anchor.node.name}`, anchor.node.certainty, anchor.node.source) : null; });
    summary = `${candidates.length} name-based candidate hypotheses; up to 12 anchors returned. Candidates are not verified features.`;
  } else {
    const coverage = graph.sourceCoverage;
    summary = coverage ? `${coverage.analyzedFiles} analyzed, ${coverage.eligibleFiles} eligible, ${coverage.selectedFiles} selected, ${coverage.omittedFiles} omitted, ${coverage.skippedFiles} excluded or skipped; ${coverage.partial ? "partial" : "complete supported-source"} analysis.` : `${graph.scan.fileCount} analyzed; eligible and omitted counts unavailable.`;
    return { tool, summary, items: [], coverage: coverage ?? { analyzedFiles: graph.scan.fileCount } };
  }
  const unique = new Map<string, Omit<PacketItem, "id">>();
  for (const entry of items) if (entry) unique.set(`${entry.source.path}:${entry.source.startLine}`, entry);
  return { tool, summary, items: [...unique.values()].slice(0, 12), ...(searchMatchCount !== undefined ? { matchCount: searchMatchCount } : {}) };
}
