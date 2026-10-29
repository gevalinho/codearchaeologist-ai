import type { BusinessRuleEvidence, Edge, Graph, Node, SourceRef } from "../archaeology/scanner";

export type WorkflowCandidate = { id: string; title: string; status: "inferred-grouping"; rules: BusinessRuleEvidence[]; componentIds: string[]; connectingEdges: Edge[]; sourceRefs: SourceRef[] };

/** A grouping is a navigation aid, not a verified execution path or business intent. */
export function discoverBusinessWorkflows(graph: Graph): WorkflowCandidate[] {
  const rules = graph.rules ?? [];
  if (!rules.length) return [];
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const owners = new Set(rules.map(rule => rule.ownerNodeId).filter(id => nodes.has(id)));
  const parent = new Map([...owners].map(id => [id, id]));
  const root = (id: string): string => { let current = id; while (parent.get(current) !== current) current = parent.get(current)!; return current; };
  const links = graph.edges.filter(edge => owners.has(edge.from) && owners.has(edge.to) && /^calls-/.test(edge.kind));
  for (const edge of links) parent.set(root(edge.to), root(edge.from));
  const groups = new Map<string, BusinessRuleEvidence[]>();
  for (const rule of rules) {
    if (!owners.has(rule.ownerNodeId)) continue;
    const key = root(rule.ownerNodeId);
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  return [...groups.values()].map(group => {
    const ordered = [...group].sort((a, b) => a.source.path.localeCompare(b.source.path) || a.source.startLine - b.source.startLine || a.id.localeCompare(b.id));
    const componentIds = [...new Set(ordered.map(rule => rule.ownerNodeId))].sort();
    const ids = new Set(componentIds);
    const connectingEdges = links.filter(edge => ids.has(edge.from) && ids.has(edge.to));
    const first: Node = nodes.get(componentIds[0])!;
    const sourceRefs = [...new Map([...ordered.map(rule => rule.source), ...connectingEdges.map(edge => edge.source)].map(ref => [`${ref.path}:${ref.startLine}:${ref.endLine}`, ref])).values()];
    return { id: `workflow:${ordered[0].id}`, title: componentIds.length === 1 ? `Rules in ${first.name.split("#").at(-1)}` : `Related rules across ${componentIds.length} components`, status: "inferred-grouping" as const, rules: ordered, componentIds, connectingEdges, sourceRefs };
  }).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export function searchBusinessWorkflows(workflows: WorkflowCandidate[], graph: Graph, query: string): WorkflowCandidate[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return workflows;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  return workflows.filter(workflow => `${workflow.title} ${workflow.rules.map(rule => `${rule.kind} ${rule.description} ${rule.source.path}`).join(" ")} ${workflow.componentIds.map(id => nodes.get(id)?.name ?? "").join(" ")}`.toLocaleLowerCase().includes(term));
}
