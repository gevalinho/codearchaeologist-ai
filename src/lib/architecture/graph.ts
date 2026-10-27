import type { Edge, Graph, Node, SourceRef } from "../archaeology/scanner";

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_VISIBLE_NODES = 36;
export const MAX_VISIBLE_EDGES = 90;
const kinds = new Set(["file", "class", "method", "angular-module", "controller", "service", "factory", "table", "endpoint", "branch"]);
const domains = new Set(["school-management", "healthcare-legacy", "shared-infrastructure", "unknown"]);
const certainty = new Set(["observed", "inferred"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, max = 500): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export function safePath(value: unknown): value is string {
  return string(value, 500) && !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== "..") && !/[<>]/.test(value);
}
function validSource(value: unknown): value is SourceRef {
  return record(value) && safePath(value.path) && Number.isSafeInteger(value.startLine) && Number.isSafeInteger(value.endLine) && (value.startLine as number) > 0 && (value.endLine as number) >= (value.startLine as number);
}
export function parseGraph(input: string, byteLength = new TextEncoder().encode(input).length): Graph {
  if (byteLength > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the 5 MB limit.");
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error("Invalid JSON artifact."); }
  if (!record(value) || value.schemaVersion !== "1.0.0") throw new Error("Unsupported graph schema version. Expected 1.0.0.");
  if (!string(value.snapshotId, 128) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 20000 || value.edges.length > 50000) throw new Error("Invalid graph structure or count.");
  if (!Array.isArray(value.warnings) || !value.warnings.every(x => typeof x === "string") || !Array.isArray(value.limitations) || !value.limitations.every(x => typeof x === "string")) throw new Error("Invalid graph metadata.");
  if (!record(value.scan) || !Number.isSafeInteger(value.scan.fileCount) || !Number.isSafeInteger(value.scan.totalBytes) || (value.scan.fileCount as number) < 0 || (value.scan.totalBytes as number) < 0) throw new Error("Invalid scan metadata.");
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!record(node) || !string(node.id) || !string(node.name) || !kinds.has(node.kind as string) || !domains.has(node.domain as string) || !certainty.has(node.certainty as string) || !string(node.method) || !validSource(node.source)) throw new Error("Invalid node structure or source reference.");
    if (nodeIds.has(node.id)) throw new Error("Duplicate node ID.");
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (!record(edge) || !string(edge.id) || !string(edge.from) || !string(edge.to) || !string(edge.kind) || !certainty.has(edge.certainty as string) || !string(edge.method) || !validSource(edge.source)) throw new Error("Invalid edge structure or source reference.");
    if (edgeIds.has(edge.id)) throw new Error("Duplicate edge ID.");
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error("Edge references a missing node.");
    edgeIds.add(edge.id);
  }
  return value as Graph;
}
export const sourceReference = (source: SourceRef) => `${source.path}:${source.startLine}${source.endLine === source.startLine ? "" : `-${source.endLine}`}`;
export type Filters = { query: string; domains: Set<string>; kinds: Set<string>; certainties: Set<string> };
export function filterNodes(nodes: Node[], filters: Filters): Node[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return nodes.filter(node => (!query || `${node.name} ${node.source.path} ${node.kind}`.toLocaleLowerCase().includes(query)) && (!filters.domains.size || filters.domains.has(node.domain)) && (!filters.kinds.size || filters.kinds.has(node.kind)) && (!filters.certainties.size || filters.certainties.has(node.certainty)));
}
export function indexGraph(graph: Graph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map<string, Edge[]>(), outgoing = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  return { nodes, incoming, outgoing };
}
export function neighborhood(graph: Graph, seeds: string[], depth = 1, direction: "both" | "incoming" | "outgoing" = "both") {
  const index = indexGraph(graph), seen = new Set(seeds.filter(id => index.nodes.has(id))), queue = [...seen].map(id => ({ id, distance: 0 }));
  for (let i = 0; i < queue.length && seen.size < MAX_VISIBLE_NODES; i++) {
    const current = queue[i];
    if (current.distance >= depth) continue;
    const edges = [...(direction === "outgoing" ? [] : index.incoming.get(current.id) ?? []), ...(direction === "incoming" ? [] : index.outgoing.get(current.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    for (const edge of edges) {
      const next = edge.from === current.id ? edge.to : edge.from;
      if (!seen.has(next) && seen.size < MAX_VISIBLE_NODES) { seen.add(next); queue.push({ id: next, distance: current.distance + 1 }); }
    }
  }
  const nodes = [...seen].map(id => index.nodes.get(id)!).sort((a, b) => a.id.localeCompare(b.id));
  const edges = graph.edges.filter(edge => seen.has(edge.from) && seen.has(edge.to)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_VISIBLE_EDGES);
  return { nodes, edges, truncated: nodes.length < graph.nodes.length || edges.length < graph.edges.length };
}
export function layout(nodes: Node[]) {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  return new Map(ordered.map((node, i) => [node.id, { x: 150 + (i % 4) * 230, y: 100 + Math.floor(i / 4) * 135 }]));
}
const promotionTerms = ["promotionCtr", "getPromotion", "putPromotion", "putScore", "getCollatedResultinput", "index.php/reg/putpromotion", "index.php/gett/getpromotiondata"];
export function promotionInvestigation(graph: Graph) {
  const matches = promotionTerms.map(term => ({ term, node: graph.nodes.find(node => node.name.toLowerCase().includes(term.toLowerCase())) })).filter(item => item.node !== undefined);
  return { matches, missing: promotionTerms.filter(term => !matches.some(item => item.term === term)), view: neighborhood(graph, matches.map(item => item.node!.id), 1) };
}
