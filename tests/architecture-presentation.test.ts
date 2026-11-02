import { describe, expect, it } from "vitest";
import type { Node } from "../src/lib/archaeology/scanner";
import {
  classifyArchitectureNode,
  filterArchitectureNodes,
  likelyThirdPartyNodeIds,
  selectInitialArchitectureSeed,
} from "../src/lib/architecture/architecture-presentation";

const makeNode = (
  id: string,
  kind: Node["kind"],
  path: string,
  name = path,
): Node => ({
  id,
  kind,
  name,
  domain: "unknown",
  source: { path, startLine: 1, endLine: 1 },
  certainty: "observed",
  method: "fixture",
});
const filters = (query = "") => ({
  query,
  domains: new Set<string>(),
  kinds: new Set<string>(),
  certainties: new Set<string>(),
});

describe("architecture presentation", () => {
  it("classifies recognizable vendor locations and direct asset-library filenames", () => {
    expect(classifyArchitectureNode(makeNode(
      "jquery",
      "file",
      "assets/js/jquery-3.7.1.js",
    ))).toBe("likely-third-party");
    expect(classifyArchitectureNode(makeNode(
      "vendor-service",
      "service",
      "vendor/angular/services.js",
    ))).toBe("likely-third-party");
    expect(classifyArchitectureNode(makeNode(
      "angular-module-import",
      "module",
      "src/app.ts",
      "src/app.ts#@uirouter/angularjs",
    ))).toBe("likely-third-party");
  });

  it("keeps ambiguous application filenames out of vendor classification", () => {
    for (const filename of [
      "angular.main.js",
      "app.js",
      "routes.js",
      "services.js",
    ]) {
      expect(classifyArchitectureNode(makeNode(
        filename,
        "file",
        `assets/js/${filename}`,
      ))).toBe("application");
    }
    expect(classifyArchitectureNode(makeNode(
      "bootstrap-ambiguous",
      "file",
      "assets/js/bootstrap.js",
    ))).toBe("unclassified");
    expect(classifyArchitectureNode(makeNode(
      "custom-asset-script",
      "file",
      "assets/js/results-feature.js",
    ))).toBe("unclassified");
    expect(classifyArchitectureNode(makeNode(
      "unknown-module",
      "module",
      "src/main.ts",
      "src/main.ts#internal-alias",
    ))).toBe("unclassified");
  });

  it("chooses a deterministic application-first initial seed", () => {
    const nodes = [
      makeNode("file:app.js", "file", "assets/js/app.js"),
      makeNode("controller:vendor", "controller", "assets/js/angular.js"),
      makeNode("service:app", "service", "application/services/Results.php"),
      makeNode("route:app", "route", "application/config/routes.php"),
    ];

    expect(selectInitialArchitectureSeed(nodes)).toBe("route:app");
    expect(selectInitialArchitectureSeed([...nodes].reverse())).toBe("route:app");
    expect(selectInitialArchitectureSeed([
      nodes[0],
      nodes[1],
    ])).toBe("file:app.js");
  });

  it("hides likely vendor nodes by default and reveals them without changing search semantics", () => {
    const nodes = [
      makeNode("angular", "file", "assets/js/angular.js"),
      makeNode("app", "controller", "assets/js/angular.main.js", "resultCtr"),
      makeNode("jquery", "file", "assets/js/jquery.js"),
    ];

    expect(filterArchitectureNodes(nodes, filters()).map((node) => node.id))
      .toEqual(["app"]);
    expect(filterArchitectureNodes(nodes, filters("jquery")).map((node) => node.id))
      .toEqual([]);
    expect(filterArchitectureNodes(nodes, filters("jquery"), true).map((node) => node.id))
      .toEqual(["jquery"]);
    expect(filterArchitectureNodes(nodes, filters("result"), true).map((node) => node.id))
      .toEqual(["app"]);
    expect(likelyThirdPartyNodeIds(nodes)).toEqual(new Set(["angular", "jquery"]));
  });
});
