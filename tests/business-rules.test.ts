import { describe, expect, it } from "vitest";
import { graphFromSources } from "../src/lib/archaeology/scanner-core";
import { rulePatterns } from "../src/lib/archaeology/rule-patterns";
import { discoverBusinessWorkflows, searchBusinessWorkflows } from "../src/lib/architecture/business-rules";
import { parseGraph } from "../src/lib/architecture/graph";
import demoGraph from "./fixtures/architecture/demo-graph.json";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BusinessRulesExplorer from "../src/app/architecture/business-rules-explorer";

const ref = { path: "application/controllers/Orders.php", startLine: 7, endLine: 7 };
const source = (path: string, content: string) => ({ path, content, bytes: Buffer.byteLength(content) });

describe("evidence-based business rules", () => {
  it("detects supported rule patterns with exact source references", () => {
    const cases = [
      ["if (empty($request)) {", "validation"],
      ["if ($role === 'admin') {", "authorization"],
      ["if ($score >= 40) {", "condition"],
      ["$order->status = 'approved';", "state-transition"],
      ["$total = $price * $quantity;", "calculation"],
    ] as const;
    for (const [line, kind] of cases) expect(rulePatterns(line, "method:Orders#save", ref)).toMatchObject([{ kind, source: ref, certainty: "observed" }]);
  });
  it("does not turn comments, strings, or incomplete conditions into rules", () => {
    for (const line of ["// if ($role === 'admin') {", "/* $order->status = 'approved'; */", "echo \"if ($role === 'admin')\";", "if ($score", "$message = 'price * quantity';"]) expect(rulePatterns(line, "file:Orders", ref)).toEqual([]);
  });
  it("does not report rules inside multi-line block comments", async () => {
    const graph = await graphFromSources([source("application/controllers/Orders.php", `<?php
/*
if ($role === 'admin') { }
$order->status = 'approved';
*/
class Orders { function index() { return 1; } }`)], []);
    expect(graph.rules).toEqual([]);
  });
  it("retains rule evidence in a parseable graph and groups connected components only as candidates", async () => {
    const controller = source("application/controllers/Orders.php", `<?php
class Orders {
 function save() {
  if (empty($request)) { return; }
  $this->get_model->find();
 }
}`);
    const model = source("application/models/Get_model.php", `<?php
class Get_model {
 function find() {
  if ($role === 'admin') { return; }
 }
}`);
    const graph = parseGraph(JSON.stringify(await graphFromSources([controller, model], [])));
    expect(graph.rules?.map(rule => rule.kind)).toEqual(["validation", "authorization"]);
    expect(graph.rules?.[0].source).toEqual({ path: controller.path, startLine: 4, endLine: 4 });
    const workflows = discoverBusinessWorkflows(graph);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({ status: "inferred-grouping", componentIds: expect.arrayContaining(["method:application/controllers/Orders.php#save", "method:application/models/Get_model.php#find"]) });
    expect(workflows[0].connectingEdges).toHaveLength(1);
    expect(searchBusinessWorkflows(workflows, graph, "authorization")).toHaveLength(1);
    expect(searchBusinessWorkflows(workflows, graph, "unrelated")).toHaveLength(0);
  });
  it("accepts older artifacts and returns no findings when evidence is absent", async () => {
    const old = parseGraph(JSON.stringify(demoGraph));
    expect(discoverBusinessWorkflows(old)).toEqual([]);
    expect(renderToStaticMarkup(createElement(BusinessRulesExplorer, { graph: old, onSelectNode: () => undefined }))).toContain("predates rule evidence");
    const empty = parseGraph(JSON.stringify(await graphFromSources([source("application/controllers/Empty.php", "<?php class Empty { function index() { return 1; } }")], [])));
    expect(empty.rules).toEqual([]);
    expect(discoverBusinessWorkflows(empty)).toEqual([]);
    expect(renderToStaticMarkup(createElement(BusinessRulesExplorer, { graph: empty, onSelectNode: () => undefined }))).toContain("No supported business-rule patterns");
  });
  it("rejects rule evidence without a real component or source location", async () => {
    const graph = await graphFromSources([source("application/controllers/Orders.php", "<?php class Orders { function save() { if (empty($request)) {} } }")], []);
    expect(() => parseGraph(JSON.stringify({ ...graph, rules: [{ ...graph.rules![0], ownerNodeId: "missing" }] }))).toThrow(/business-rule evidence/);
  });
});
