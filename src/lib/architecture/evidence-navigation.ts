import type { Edge, Graph, SourceRef } from "../archaeology/scanner";

export type EvidenceSelection = { type: "node" | "edge"; id: string };
export type GraphNavigationState = {
  focus: string[];
  selected: EvidenceSelection | null;
  focusedEvidenceRef: SourceRef | null;
};
export type GraphNavigationAction =
  | { type: "reset" }
  | { type: "focus-nodes"; ids: string[] }
  | { type: "select-node"; id: string }
  | { type: "select-edge"; edge: Pick<Edge, "id" | "from" | "to"> }
  | { type: "focus-citation"; graph: Graph | null; ref: SourceRef };

export const initialGraphNavigationState: GraphNavigationState = {
  focus: [],
  selected: null,
  focusedEvidenceRef: null,
};

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

export function reduceGraphNavigation(
  state: GraphNavigationState,
  action: GraphNavigationAction,
): GraphNavigationState {
  switch (action.type) {
    case "reset":
      return initialGraphNavigationState;
    case "focus-nodes":
      return {
        focus: action.ids,
        selected: null,
        focusedEvidenceRef: null,
      };
    case "select-node":
      return {
        focus: [action.id],
        selected: { type: "node", id: action.id },
        focusedEvidenceRef: null,
      };
    case "select-edge":
      return {
        focus: [action.edge.from, action.edge.to],
        selected: { type: "edge", id: action.edge.id },
        focusedEvidenceRef: null,
      };
    case "focus-citation": {
      const selected = resolveEvidenceSelection(action.graph, action.ref);
      const edge = selected?.type === "edge"
        ? action.graph?.edges.find((candidate) => candidate.id === selected.id)
        : undefined;
      return {
        focus: selected?.type === "node"
          ? [selected.id]
          : edge ? [edge.from, edge.to] : [],
        selected,
        focusedEvidenceRef: action.ref,
      };
    }
  }
}
