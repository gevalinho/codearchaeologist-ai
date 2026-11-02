import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Edge, Graph, Node, SourceRef } from "../src/lib/archaeology/scanner";
import ArchitectureHealth from "../src/app/architecture/architecture-health";
import {
  analyzeArchitectureHealth,
  type ArchitectureHealthFinding,
  ARCHITECTURE_HEALTH_THRESHOLDS,
} from "../src/lib/architecture/architecture-health";
import { groupArchitectureHealthFindings } from "../src/app/architecture/architecture-health";
import { reduceGraphNavigation, initialGraphNavigationState } from "../src/lib/architecture/evidence-navigation";

const source = (
  path: string,
  startLine = 1,
  endLine = startLine,
): SourceRef => ({ path, startLine, endLine });

const node = (
  id: string,
  kind: Node["kind"],
  name = id,
  ref = source(`src/${id}.php`),
): Node => ({
  id,
  kind,
  name,
  domain: "unknown",
  source: ref,
  certainty: "observed",
  method: "fixture",
});

const edge = (
  id: string,
  from: string,
  to: string,
  kind = "declares",
  ref = source(`src/${id}.php`),
  certainty: Edge["certainty"] = "observed",
): Edge => ({ id, from, to, kind, source: ref, certainty, method: "fixture" });

const graph = (nodes: Node[], edges: Edge[] = []): Graph => ({
  schemaVersion: "1.0.0",
  snapshotId: "health-fixture",
  nodes,
  edges,
  warnings: [],
  limitations: [],
  scan: { fileCount: 0, totalBytes: 0 },
});

function controllerWithMethods(
  count: number,
  controllerSource = source("src/OrdersController.php", 1, 20),
  names?: string[],
) {
  const componentId = `controller:${controllerSource.path}`;
  const controller = node(
    componentId,
    "controller",
    controllerSource.path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "OrdersController",
    controllerSource,
  );
  const methods = Array.from({ length: count }, (_, index) =>
    node(
      `${componentId}:method-${index}`,
      "method",
      names?.[index] ?? `processAction${index}`,
      source("src/OrdersController.php", index + 2, index + 2),
    ),
  );
  return {
    component: controller,
    methods,
    graph: graph(
      [controller, ...methods],
      methods.map((method, index) =>
        edge(
          `${componentId}:declares-${index}`,
          controller.id,
          method.id,
          "declares",
          method.source,
        ),
      ),
    ),
  };
}

describe("deterministic architecture health diagnostics", () => {
  it("measures oversized controllers and classes without treating size as a defect", () => {
    const controller = node(
      "controller",
      "controller",
      "LargeController",
      source("src/LargeController.php", 10, 209),
    );
    const klass = node(
      "class",
      "class",
      "VeryLargeClass",
      source("src/LargeClass.php", 1, 450),
    );
    const result = analyzeArchitectureHealth(graph([controller, klass]));

    expect(result.categoryCounts["oversized-component"]).toBe(2);
    expect(result.findings.map((finding) => finding.metrics[0].value)).toEqual([
      450,
      200,
    ]);
    expect(result.findings[0].priority).toBe("high");
    expect(result.findings[1].priority).toBe("medium");
    expect(result.findings.every((finding) =>
      finding.explanation.includes("not proof") ||
      finding.priorityExplanation.includes("size alone"),
    )).toBe(true);
    expect(result.findings[0].evidence.sourceRefs).toContainEqual(klass.source);
  });

  it("flags high observed method counts but leaves small controllers unflagged", () => {
    const large = controllerWithMethods(25);
    const small = controllerWithMethods(
      4,
      source("src/SmallController.php", 1, 24),
      ["getUser", "saveUser", "deleteUser", "validateUser"],
    );
    const medium = controllerWithMethods(
      15,
      source("src/MediumController.php", 1, 30),
    );
    const result = analyzeArchitectureHealth(graph(
      [...large.graph.nodes, ...small.graph.nodes, ...medium.graph.nodes],
      [...large.graph.edges, ...small.graph.edges, ...medium.graph.edges],
    ));

    const methodFinding = result.findings.find(
      (finding) =>
        finding.category === "method-concentration" &&
        finding.component.id === large.component.id,
    );
    expect(methodFinding?.metrics[0]).toMatchObject({
      value: 25,
      threshold: expect.stringContaining("≥ 15"),
      basis: "observed-structure",
    });
    expect(methodFinding?.priority).toBe("high");
    expect(result.findings.find((finding) =>
      finding.category === "method-concentration" &&
      finding.component.id === medium.component.id,
    )?.priority).toBe("medium");
    expect(result.findings.some((finding) =>
      finding.component.id === small.component.id,
    )).toBe(false);
    expect(ARCHITECTURE_HEALTH_THRESHOLDS.concentratedMethods).toBe(15);
  });

  it("reports repeated method-name topics only as a low-priority heuristic", () => {
    const fixture = controllerWithMethods(
      4,
      source("src/FeatureController.php", 1, 50),
      ["getUser", "saveUser", "getInvoice", "saveInvoice"],
    );
    const finding = analyzeArchitectureHealth(fixture.graph).findings.find(
      (item) => item.category === "mixed-responsibility-signal",
    );

    expect(finding?.basis).toBe("heuristic");
    expect(finding?.priority).toBe("low");
    expect(finding?.explanation).toContain("invoice (2)");
    expect(finding?.explanation).toContain("user (2)");
    expect(finding?.limitations.join(" ")).toContain("not proof");
    expect(finding?.nextSteps.join(" ")).toContain("service extraction");
  });

  it("counts distinct observed dependency neighbors and ignores declarations", () => {
    const component = node("controller", "controller", "CatalogController");
    const neighbors = Array.from({ length: 8 }, (_, index) =>
      node(`route-${index}`, "route", `/catalog/${index}`),
    );
    const edges = neighbors.map((neighbor, index) =>
      edge(
        `route-edge-${index}`,
        neighbor.id,
        component.id,
        "routes-to",
        source(`routes/${index}.php`),
      ),
    );
    edges.push(edge("registration", "route-0", component.id, "registers"));
    edges.push(edge(
      "inferred-edge",
      "route-1",
      component.id,
      "calls",
      source("routes/inferred.php"),
      "inferred",
    ));
    const result = analyzeArchitectureHealth(graph(
      [component, ...neighbors],
      edges,
    ));
    const finding = result.findings.find(
      (item) => item.category === "dependency-concentration",
    );

    expect(finding?.metrics.map((metric) => metric.value)).toEqual([8, 0]);
    expect(finding?.evidence.edges).toHaveLength(8);
    expect(finding?.priority).toBe("medium");
  });

  it("raises high review priority for at least 15 outgoing graph neighbors", () => {
    const component = node("service", "service", "ReportService");
    const neighbors = Array.from({ length: 15 }, (_, index) =>
      node(`target-${index}`, "method", `renderReport${index}`),
    );
    const relationships = neighbors.map((neighbor, index) =>
      edge(
        `calls-${index}`,
        component.id,
        neighbor.id,
        "calls",
        source(`src/ReportService.php`, index + 2),
      ),
    );
    const finding = analyzeArchitectureHealth(
      graph([component, ...neighbors], relationships),
    ).findings.find((item) => item.category === "dependency-concentration");

    expect(finding?.metrics.map((metric) => metric.value)).toEqual([0, 15]);
    expect(finding?.priority).toBe("high");
    expect(finding?.severity).toBe("high");
  });

  it("skips invalid line measurements and preserves findings with incomplete evidence", () => {
    const fixture = controllerWithMethods(15);
    const malformed = JSON.parse(JSON.stringify(fixture.graph)) as Graph;
    malformed.nodes[0].source = { path: "", startLine: 0, endLine: 0 };
    for (const method of malformed.nodes.slice(1)) {
      method.source = { path: "", startLine: 0, endLine: 0 };
    }
    for (const relationship of malformed.edges) {
      relationship.source = { path: "", startLine: 0, endLine: 0 };
    }

    const result = analyzeArchitectureHealth(malformed);
    const finding = result.findings.find(
      (item) => item.category === "method-concentration",
    );

    expect(result.findings.some((item) => item.category === "oversized-component"))
      .toBe(false);
    expect(finding?.sourcePath).toBeNull();
    expect(finding?.evidence.sourceRefs).toHaveLength(0);
    expect(finding?.limitations.join(" ")).toContain("incomplete");
  });

  it("returns the same findings when graph nodes and edges are reordered", () => {
    const fixture = controllerWithMethods(
      4,
      source("src/FeatureController.php", 1, 50),
      ["getUser", "saveUser", "getInvoice", "saveInvoice"],
    );
    const original = analyzeArchitectureHealth(fixture.graph);
    const reordered = analyzeArchitectureHealth({
      ...fixture.graph,
      nodes: [...fixture.graph.nodes].reverse(),
      edges: [...fixture.graph.edges].reverse(),
    });

    expect(reordered.findings).toEqual(original.findings);
    expect(reordered.categoryCounts).toEqual(original.categoryCounts);
  });

  it("groups every finding by stable component id without dropping distinct duplicates", () => {
    const alpha = controllerWithMethods(
      25,
      source("src/AlphaController.php", 1, 450),
      [
        "getUser", "saveUser", "getInvoice", "saveInvoice",
        ...Array.from({ length: 21 }, (_, index) => `processAction${index}`),
      ],
    );
    const zed = controllerWithMethods(
      25,
      source("src/ZedController.php", 1, 450),
      [
        "getUser", "saveUser", "getInvoice", "saveInvoice",
        ...Array.from({ length: 21 }, (_, index) => `processAction${index}`),
      ],
    );
    const medium = controllerWithMethods(
      15,
      source("src/MediumController.php", 1, 200),
    );
    const findings = analyzeArchitectureHealth(graph(
      [...alpha.graph.nodes, ...zed.graph.nodes, ...medium.graph.nodes],
      [...alpha.graph.edges, ...zed.graph.edges, ...medium.graph.edges],
    )).findings;
    const distinctDuplicate: ArchitectureHealthFinding = {
      ...findings[0],
      id: `${findings[0].id}:additional-evidence`,
      explanation: "A distinct finding in the same category with additional evidence.",
      metrics: [{
        label: "Additional observed metric",
        value: 7,
        threshold: "≥ 5",
        basis: "observed-structure",
      }],
    };
    const groups = groupArchitectureHealthFindings([
      ...findings,
      distinctDuplicate,
    ]);

    expect(groups.map((group) => group.component.id)).toEqual([
      alpha.component.id,
      zed.component.id,
      medium.component.id,
    ]);
    expect(groups.map((group) => group.highestPriority)).toEqual([
      "high",
      "high",
      "medium",
    ]);
    expect(groups[0].findings).toHaveLength(4);
    expect(groups[0].findings.map((finding) => finding.id)).toContain(
      distinctDuplicate.id,
    );
    expect(groups[0].structuralMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Measured source span", value: 450 }),
      expect.objectContaining({ label: "Observed declared methods", value: 25 }),
      expect.objectContaining({ label: "Additional observed metric", value: 7 }),
    ]));
    expect(groups[2].findings).toHaveLength(2);
  });

  it("sorts groups by highest priority, finding count, then stable component id", () => {
    const highMoreFindings = controllerWithMethods(
      25,
      source("src/ZedController.php", 1, 450),
    );
    const highFewerFindings = controllerWithMethods(
      0,
      source("src/AlphaController.php", 1, 450),
    );
    const mediumMoreFindings = controllerWithMethods(
      15,
      source("src/ZuluController.php", 1, 200),
    );
    const mediumFewerFindings = controllerWithMethods(
      0,
      source("src/BetaController.php", 1, 200),
    );
    const findings = analyzeArchitectureHealth(graph(
      [
        ...highMoreFindings.graph.nodes,
        ...highFewerFindings.graph.nodes,
        ...mediumMoreFindings.graph.nodes,
        ...mediumFewerFindings.graph.nodes,
      ],
      [
        ...highMoreFindings.graph.edges,
        ...highFewerFindings.graph.edges,
        ...mediumMoreFindings.graph.edges,
        ...mediumFewerFindings.graph.edges,
      ],
    )).findings;

    expect(groupArchitectureHealthFindings(findings).map((group) => [
      group.component.id,
      group.highestPriority,
      group.findings.length,
    ])).toEqual([
      [highMoreFindings.component.id, "high", 2],
      [highFewerFindings.component.id, "high", 1],
      [mediumMoreFindings.component.id, "medium", 2],
      [mediumFewerFindings.component.id, "medium", 1],
    ]);
  });

  it("stops before processing graphs above the explicit size limits", () => {
    const oversizedGraph = graph(
      Array.from({ length: ARCHITECTURE_HEALTH_THRESHOLDS.maximumNodes + 1 }, (_, index) =>
        node(`file-${index}`, "file"),
      ),
    );
    const result = analyzeArchitectureHealth(oversizedGraph);

    expect(result.findings).toEqual([]);
    expect(result.analysisSkipped).toBe(true);
    expect(result.limitMessage).toContain(
      `${ARCHITECTURE_HEALTH_THRESHOLDS.maximumNodes.toLocaleString()} nodes`,
    );
    expect(result.totalFindings).toBe(0);
  });

  it("keeps the largest supported node count within the bounded analysis path", () => {
    const largestSupportedGraph = graph(
      Array.from({ length: ARCHITECTURE_HEALTH_THRESHOLDS.maximumNodes }, (_, index) =>
        node(`file-${index}`, "file"),
      ),
    );

    expect(analyzeArchitectureHealth(largestSupportedGraph)).toMatchObject({
      analysisSkipped: false,
      limitMessage: null,
    });
  });

  it("renders evidence links and graph-navigation actions for a finding", () => {
    const fixture = controllerWithMethods(
      0,
      source("src/LargeController.php", 1, 250),
    );
    const html = renderToStaticMarkup(createElement(ArchitectureHealth, {
      graph: fixture.graph,
      onExploreComponent: vi.fn(),
      onFocusEvidence: vi.fn(),
    }));

    expect(html).toContain("Architecture health");
    expect(html).toContain("LargeController");
    expect(html).toContain("src/LargeController.php:1-250");
    expect(html).toContain("Explore component in relationship map");
  });

  it("offers the AI advisor behind an explicit bounded-metadata consent review", () => {
    const fixture = controllerWithMethods(
      0,
      source("src/LargeController.php", 1, 250),
    );
    const html = renderToStaticMarkup(createElement(ArchitectureHealth, {
      graph: fixture.graph,
      origin: "browser-local",
      artifactId: null,
      onExploreComponent: vi.fn(),
      onFocusEvidence: vi.fn(),
    }));

    expect(html).toContain("Ask AI Advisor");
    expect(html).toContain("only bounded labels, measurements, relationships, and source references");
    expect(html).toContain("Source bodies are excluded");
    expect(html).not.toContain("I agree to send this bounded Architecture Health evidence");
  });

  it("renders one initially collapsed component card with all finding details and navigation", () => {
    const fixture = controllerWithMethods(
      25,
      source("src/ExpandableController.php", 1, 450),
      [
        "getUser", "saveUser", "getInvoice", "saveInvoice",
        ...Array.from({ length: 21 }, (_, index) => `processAction${index}`),
      ],
    );
    const html = renderToStaticMarkup(createElement(ArchitectureHealth, {
      graph: fixture.graph,
      onExploreComponent: vi.fn(),
      onFocusEvidence: vi.fn(),
    }));

    expect(html.match(/class="health-component-group /g)).toHaveLength(1);
    expect(html).toContain('<details class="health-component-group health-priority-high">');
    expect(html).toContain("<strong>ExpandableController</strong>");
    expect(html).toContain("<strong>3</strong>");
    expect(html).toContain("Measured source span");
    expect(html).toContain("Observed declared methods");
    expect(html).toContain("Supporting evidence");
    expect(html).toContain("Limitations");
    expect(html).toContain("Suggested next investigation");
    expect(html).toContain("src/ExpandableController.php:1-450");
    expect(html).toContain("Explore component in relationship map");
    expect(html).toContain("Components flagged");
    expect(html).toContain("Total findings");
    expect(html).not.toContain('<details class="health-component-group health-priority-high" open>');
  });

  it("maps a diagnostic component and citation into existing graph navigation", () => {
    const fixture = controllerWithMethods(
      0,
      source("src/LargeController.php", 1, 250),
    );
    const finding = analyzeArchitectureHealth(fixture.graph).findings[0];
    const selected = reduceGraphNavigation(initialGraphNavigationState, {
      type: "select-node",
      id: finding.component.id,
    });
    const evidence = reduceGraphNavigation(selected, {
      type: "focus-citation",
      graph: fixture.graph,
      ref: finding.evidence.sourceRefs[0],
    });

    expect(selected.selected).toEqual({
      type: "node",
      id: finding.component.id,
    });
    expect(evidence.focus).toEqual([finding.component.id]);
    expect(evidence.focusedEvidenceRef).toEqual(finding.evidence.sourceRefs[0]);
  });
});
