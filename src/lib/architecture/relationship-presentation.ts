import type { Edge, Graph, Node, SourceRef } from "../archaeology/scanner";

export type RelationshipRecord =
  Pick<Edge, "from" | "to" | "kind" | "certainty" | "method"> & {
    source?: SourceRef;
  };

export function relationshipEndpointIds(
  edge: Pick<Edge, "from" | "to">,
): string[] {
  return edge.from === edge.to ? [edge.from] : [edge.from, edge.to];
}

export function describeRelationship(
  edge: RelationshipRecord,
  nodes: ReadonlyMap<string, Node>,
) {
  return {
    kind: edge.kind,
    sourceComponent: nodes.get(edge.from),
    targetComponent: nodes.get(edge.to),
    certainty: edge.certainty,
    certaintyDescription: edge.certainty === "observed"
      ? "Observed source pattern; not runtime verified."
      : "Inferred relationship; review the cited source.",
    extractionMethod: edge.method,
    source: edge.source ?? null,
  };
}

const relationshipDescriptions: Record<string, string> = {
  "calls-endpoint": "component calls endpoint",
  "calls-model-method": "method calls model method",
  "calls-php-method": "method calls method",
  "declares": "source declares component",
  "declares-route": "source declares route",
  "depends-on": "file has a dependency specifier",
  "dispatches-to": "static dispatch branch targets method",
  "imports": "file imports module",
  "makes-http-call": "component makes a dynamic HTTP call",
  "registers": "source registers component",
  "resolves-to": "import resolves to scanned source",
  "routes-to": "route targets component",
};

export function relationshipLegend(graph: Graph): {
  kinds: { kind: string; description: string }[];
  remaining: number;
} {
  const allKinds = [...new Set(graph.edges.map((edge) => edge.kind))]
    .sort((left, right) => left.localeCompare(right));
  const kinds = allKinds.slice(0, 5).map((kind) => ({
    kind,
    description: relationshipDescriptions[kind] ?? "source relationship",
  }));
  return { kinds, remaining: Math.max(0, allKinds.length - kinds.length) };
}
