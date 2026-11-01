import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node, SourceRef } from "../src/lib/archaeology/scanner";
import { resolveEvidenceSelection } from "../src/lib/architecture/evidence-navigation";

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
