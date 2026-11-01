import type { Graph, SourceRef } from "../archaeology/scanner";

export type EvidenceSelection = { type: "node" | "edge"; id: string };

function containsSource(source: SourceRef, requested: SourceRef): boolean {
  return source.path === requested.path &&
    source.startLine <= requested.startLine &&
    source.endLine >= requested.endLine;
}

export function resolveEvidenceSelection(
  graph: Graph | null,
  requested: SourceRef,
): EvidenceSelection | null {
  if (!graph) return null;

  const candidates = [
    ...graph.edges
      .filter((edge) => containsSource(edge.source, requested))
      .map((edge) => ({
        selection: { type: "edge" as const, id: edge.id },
        source: edge.source,
        priority: 0,
      })),
    ...graph.nodes
      .filter((node) => containsSource(node.source, requested))
      .map((node) => ({
        selection: { type: "node" as const, id: node.id },
        source: node.source,
        priority: 1,
      })),
  ];

  if (!candidates.length) {
    for (const rule of graph.rules ?? []) {
      if (!containsSource(rule.source, requested)) continue;
      const owner = graph.nodes.find((node) => node.id === rule.ownerNodeId);
      if (owner) {
        candidates.push({
          selection: { type: "node", id: owner.id },
          source: rule.source,
          priority: 2,
        });
      }
    }
  }

  return candidates
    .sort((left, right) =>
      (left.source.endLine - left.source.startLine) -
        (right.source.endLine - right.source.startLine) ||
      left.priority - right.priority ||
      left.selection.id.localeCompare(right.selection.id),
    )[0]?.selection ?? null;
}
