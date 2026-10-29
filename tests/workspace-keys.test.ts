import { describe, expect, it } from "vitest";
import { workspacePanelKey } from "../src/app/architecture/workspace";
import { rulePatterns } from "../src/lib/archaeology/rule-patterns";
import { graphFromSources } from "../src/lib/archaeology/scanner-core";
import { parseGraph, sourceReference } from "../src/lib/architecture/graph";

describe("workspace list identities", () => {
  it("gives sibling explorers distinct stable keys for the same artifact version", () => {
    expect(workspacePanelKey("business-rules", 1)).toBe("business-rules:1");
    expect(workspacePanelKey("modules", 1)).toBe("modules:1");
    expect(workspacePanelKey("business-rules", 1)).not.toBe(workspacePanelKey("modules", 1));
    expect(workspacePanelKey("modules", 2)).not.toBe(workspacePanelKey("modules", 1));
  });
  it("keeps distinct rule IDs when two findings cite the same source line", () => {
    const source = { path: "application/controllers/Orders.php", startLine: 4, endLine: 4 };
    const rules = rulePatterns("if ($role === 'admin') { $order->status = 'approved'; }", "method:Orders#save", source);
    expect(rules.map(rule => rule.kind)).toEqual(["authorization", "state-transition"]);
    expect(new Set(rules.map(rule => rule.id)).size).toBe(2);
    expect(rules.map(rule => sourceReference(rule.source))).toEqual(["application/controllers/Orders.php:4", "application/controllers/Orders.php:4"]);
  });
  it("rejects genuinely duplicate rule identities in an artifact", async () => {
    const content = "<?php class Orders { function save() { if (empty($request)) {} } }";
    const graph = await graphFromSources([{ path: "application/controllers/Orders.php", content, bytes: Buffer.byteLength(content) }], []);
    expect(graph.rules).toHaveLength(1);
    expect(() => parseGraph(JSON.stringify({ ...graph, rules: [graph.rules![0], graph.rules![0]] }))).toThrow(/business-rule evidence/);
  });
});
