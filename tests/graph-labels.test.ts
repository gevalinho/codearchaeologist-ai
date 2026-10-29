import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { graphNodeLabel } from "../src/lib/architecture/labels";
import { parseGraph, sourceReference } from "../src/lib/architecture/graph";

const graph = parseGraph(readFileSync(new URL("./fixtures/architecture/demo-graph.json", import.meta.url), "utf8"));

describe("graph display labels", () => {
  it("keeps method symbols useful while bounding each line", () => {
    const method = graph.nodes.find(node => node.id === "method:demo-promotion")!;
    expect(graphNodeLabel(method)).toEqual({ fullName: method.name, lines: ["DemoPromotion.php", "putPromotion"] });
    expect(graphNodeLabel(method).lines.every(line => line.length <= 20)).toBe(true);
  });
  it("shortens long file paths and method names deterministically", () => {
    const method = graph.nodes.find(node => node.kind === "method")!;
    const long = { ...method, name: "application/very/long/nested/path/ExtraordinarilyLongPromotionController.php#anExtraordinarilyLongPromotionMethodName" };
    const first = graphNodeLabel(long);
    expect(first).toEqual(graphNodeLabel(long));
    expect(first.lines).toHaveLength(2);
    expect(first.lines.every(line => line.length <= 20 && line.endsWith("…"))).toBe(true);
    expect(first.fullName).toBe(long.name);
    expect(graphNodeLabel({ ...method, kind: "file", name: "application/very/long/nested/path/ExtraordinarilyLongPromotionController.php" }).lines).toEqual(["ExtraordinarilyLong…"]);
  });
  it("preserves graph identity, source references, and branch line context", () => {
    const before = structuredClone(graph);
    const branch = graph.nodes.find(node => node.kind === "branch")!;
    expect(graphNodeLabel(branch).lines).toEqual(["DemoPromotion.php", "line 10"]);
    for (const node of graph.nodes) {
      expect(graphNodeLabel(node).fullName).toBe(node.name);
      expect(node.id).toBe(before.nodes.find(item => item.id === node.id)?.id);
      expect(sourceReference(node.source)).toBe(sourceReference(before.nodes.find(item => item.id === node.id)!.source));
    }
    expect(graph).toEqual(before);
  });
});
