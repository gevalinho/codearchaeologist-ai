import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node, SourceRef } from "../src/lib/archaeology/scanner";
import {
  describeRelationship,
  relationshipEndpointIds,
  relationshipLegend,
} from "../src/lib/architecture/relationship-presentation";
import {
  initialGraphNavigationState,
  reduceGraphNavigation,
} from "../src/lib/architecture/evidence-navigation";

const source = (path: string, startLine: number): SourceRef => ({
  path,
  startLine,
  endLine: startLine,
});

const node = (id: string, name: string, path: string): Node => ({
  id,
  name,
  kind: "method",
  domain: "unknown",
  source: source(path, 10),
  certainty: "observed",
  method: "php-ast",
});

const edge: Edge = {
  id: "calls",
  from: "controller",
  to: "model",
  kind: "calls-php-method",
  source: source("application/controllers/Results.php", 24),
  certainty: "observed",
  method: "php-same-class-call-v1",
};

const graph: Graph = {
  schemaVersion: "1.0.0",
  snapshotId: "fixture",
  nodes: [],
  edges: [edge],
  warnings: [],
  limitations: [],
  scan: { fileCount: 0, totalBytes: 0 },
};

describe("relationship presentation", () => {
  const nodes = new Map([
    ["controller", node("controller", "Results::process", "Results.php")],
    ["model", node("model", "Result_model::save", "Result_model.php")],
  ]);

  it("preserves relationship direction, certainty, method, and source evidence", () => {
    expect(describeRelationship(edge, nodes)).toEqual({
      kind: "calls-php-method",
      sourceComponent: nodes.get("controller"),
      targetComponent: nodes.get("model"),
      certainty: "observed",
      certaintyDescription: "Observed source pattern; not runtime verified.",
      extractionMethod: "php-same-class-call-v1",
      source: edge.source,
    });
    expect(relationshipEndpointIds(edge)).toEqual(["controller", "model"]);
  });

  it("marks inferred relationships without describing them as runtime verified", () => {
    const result = describeRelationship(
      { ...edge, certainty: "inferred" },
      nodes,
    );

    expect(result.certaintyDescription).toContain("Inferred");
    expect(result.certaintyDescription).not.toContain("runtime verified");
  });

  it("reports missing endpoints and source references without inventing evidence", () => {
    const result = describeRelationship(
      {
        ...edge,
        from: "missing-controller",
        source: undefined,
      },
      nodes,
    );

    expect(result.sourceComponent).toBeUndefined();
    expect(result.targetComponent?.name).toBe("Result_model::save");
    expect(result.source).toBeNull();
  });

  it("keeps a self-relationship endpoint unique", () => {
    expect(relationshipEndpointIds({ from: "same", to: "same" })).toEqual([
      "same",
    ]);
  });

  it("bounds and sorts the relationship legend deterministically", () => {
    const result = relationshipLegend({
      ...graph,
      edges: [
        ...graph.edges,
        ...["z-kind", "a-kind", "b-kind", "c-kind", "d-kind", "e-kind"].map(
          (kind) => ({ ...edge, id: kind, kind }),
        ),
      ],
    });

    expect(result.kinds.map(({ kind }) => kind)).toEqual([
      "a-kind",
      "b-kind",
      "c-kind",
      "calls-php-method",
      "d-kind",
    ]);
    expect(result.remaining).toBe(2);
    expect(relationshipLegend(graph)).toEqual(relationshipLegend(graph));
  });

  it("navigates from a selected relationship to its source or target component", () => {
    const selectedEdge = reduceGraphNavigation(initialGraphNavigationState, {
      type: "select-edge",
      edge,
    });
    const selectedEndpoint = reduceGraphNavigation(selectedEdge, {
      type: "select-node",
      id: "model",
    });

    expect(selectedEndpoint.focus).toEqual(["model"]);
    expect(selectedEndpoint.selected).toEqual({ type: "node", id: "model" });
  });
});
