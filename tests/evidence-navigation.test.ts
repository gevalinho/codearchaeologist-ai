import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node, SourceRef } from "../src/lib/archaeology/scanner";
import {
  initialGraphNavigationState,
  reduceGraphNavigation,
  resolveEvidenceSelection,
} from "../src/lib/architecture/evidence-navigation";

const source = (startLine: number, endLine: number): SourceRef => ({
  path: "assets/js/angular.main.js",
  startLine,
  endLine,
});
const node = (id: string, ref: SourceRef): Node => ({
  id,
  kind: "controller",
  name: id,
  domain: "unknown",
  source: ref,
  certainty: "observed",
  method: "fixture",
});
const edge = (id: string, ref: SourceRef): Edge => ({
  id,
  from: "from",
  to: "to",
  kind: "calls-endpoint",
  source: ref,
  certainty: "observed",
  method: "fixture",
});
const graph = (nodes: Node[], edges: Edge[]): Graph => ({
  schemaVersion: "1.0.0",
  snapshotId: "fixture",
  nodes,
  edges,
  warnings: [],
  limitations: [],
  scan: { fileCount: 0, totalBytes: 0 },
});

describe("source-reference navigation", () => {
  it("chooses an exact citation match over broader overlapping entities", () => {
    const result = resolveEvidenceSelection(
      graph(
        [node("broad-node", source(1, 100))],
        [edge("exact-edge", source(42, 42))],
      ),
      source(42, 42),
    );

    expect(result).toEqual({ type: "edge", id: "exact-edge" });
  });

  it("returns no selection when the requested citation is unmatched", () => {
    const result = resolveEvidenceSelection(
      graph(
        [node("other-file", { ...source(42, 42), path: "src/other.js" })],
        [edge("other-line", source(43, 43))],
      ),
      source(42, 42),
    );

    expect(result).toBeNull();
  });

  it("chooses the narrowest source range when ranges overlap", () => {
    const result = resolveEvidenceSelection(
      graph(
        [node("broad-node", source(1, 100)), node("narrow-node", source(40, 45))],
        [edge("wide-edge", source(30, 60))],
      ),
      source(42, 42),
    );

    expect(result).toEqual({ type: "node", id: "narrow-node" });
  });
});

describe("graph navigation state", () => {
  const nodes = [node("from", source(1, 1)), node("to", source(2, 2))];
  const relationship = edge("relationship", source(42, 42));
  const fixture = graph(nodes, [relationship]);

  it("clears node or edge selection when inventory filters change", () => {
    const nodeState = reduceGraphNavigation(initialGraphNavigationState, {
      type: "select-node",
      id: "from",
    });
    const nodeReset = reduceGraphNavigation(nodeState, { type: "reset" });
    expect(nodeReset).toEqual(initialGraphNavigationState);

    const edgeState = reduceGraphNavigation(initialGraphNavigationState, {
      type: "select-edge",
      edge: relationship,
    });
    const edgeReset = reduceGraphNavigation(edgeState, { type: "reset" });
    expect(edgeReset).toEqual(initialGraphNavigationState);
  });

  it("keeps a selected node as the viewport focus", () => {
    expect(reduceGraphNavigation(initialGraphNavigationState, {
      type: "select-node",
      id: "from",
    })).toEqual({
      focus: ["from"],
      selected: { type: "node", id: "from" },
      focusedEvidenceRef: null,
    });
  });

  it("keeps an explicitly selected edge and both endpoints in focus", () => {
    expect(reduceGraphNavigation(initialGraphNavigationState, {
      type: "select-edge",
      edge: relationship,
    })).toEqual({
      focus: ["from", "to"],
      selected: { type: "edge", id: "relationship" },
      focusedEvidenceRef: null,
    });
  });

  it("focuses both edge endpoints when navigating to its citation", () => {
    expect(reduceGraphNavigation(initialGraphNavigationState, {
      type: "focus-citation",
      graph: fixture,
      ref: source(42, 42),
    })).toEqual({
      focus: ["from", "to"],
      selected: { type: "edge", id: "relationship" },
      focusedEvidenceRef: source(42, 42),
    });
  });

  it("preserves an unmatched citation without retaining an unrelated selection", () => {
    const prior = reduceGraphNavigation(initialGraphNavigationState, {
      type: "select-node",
      id: "from",
    });
    expect(reduceGraphNavigation(prior, {
      type: "focus-citation",
      graph: fixture,
      ref: source(100, 100),
    })).toEqual({
      focus: [],
      selected: null,
      focusedEvidenceRef: source(100, 100),
    });
  });
});
