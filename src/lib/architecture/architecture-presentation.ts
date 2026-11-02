import type { Node } from "../archaeology/scanner";
import { applicationScripts } from "../archaeology/selection";
import { filterNodes, type Filters } from "./graph";

export type ComponentClassification =
  | "application"
  | "likely-third-party"
  | "unclassified";

const vendorDirectories = new Set([
  "bower_components",
  "node_modules",
  "third_party",
  "third-party",
  "vendor",
  "vendors",
]);
const knownVendorFiles = new Set([
  "angular-animate.js",
  "angular-cookies.js",
  "angular-messages.js",
  "angular-resource.js",
  "angular-route.js",
  "angular-sanitize.js",
  "angular-touch.js",
  "angular-ui-bootstrap.js",
  "angular-ui-router.js",
  "d3.js",
  "echarts.js",
  "highcharts.js",
  "lodash.js",
  "moment.js",
  "underscore.js",
]);
const knownVendorModules = new Set([
  "@uirouter/angularjs",
  "angular",
  "angular-animate",
  "angular-messages",
  "angular-resource",
  "angular-route",
  "angular-sanitize",
  "angular-touch",
  "bootstrap",
  "chart.js",
  "d3",
  "echarts",
  "highcharts",
  "jquery",
  "lodash",
  "moment",
  "react",
  "react-dom",
  "react-router",
  "react-router-dom",
  "underscore",
]);
const applicationRoots = new Set([
  "app",
  "application",
  "client",
  "components",
  "frontend",
  "pages",
  "routes",
  "src",
  "web",
]);
const ambiguousFilenames = new Set(["bootstrap.js"]);
const entrypointNames = new Set([
  "app.js",
  "index.js",
  "index.php",
  "main.js",
  "server.js",
]);
const rolePriority: Partial<Record<Node["kind"], number>> = {
  controller: 0,
  route: 1,
  service: 2,
  "angular-module": 3,
  component: 4,
  function: 5,
  class: 6,
  method: 7,
  endpoint: 8,
  "http-call": 9,
  module: 10,
  file: 11,
  factory: 12,
  table: 13,
  branch: 14,
};

function isKnownVendorFilename(filename: string): boolean {
  const normalized = filename.toLowerCase();
  return knownVendorFiles.has(normalized) ||
    /^angular(?:\.min)?\.js$/.test(normalized) ||
    /^jquery(?:-\d+(?:\.\d+){1,2})?(?:\.min)?\.js$/.test(normalized);
}

export function classifyArchitectureNode(
  node: Pick<Node, "kind" | "name" | "source">,
): ComponentClassification {
  const pathParts = node.source.path.toLowerCase().split("/");
  if (pathParts.some((part) => vendorDirectories.has(part))) {
    return "likely-third-party";
  }

  const filename = pathParts.at(-1) ?? "";
  if (isKnownVendorFilename(filename)) return "likely-third-party";

  if (node.kind === "module") {
    const specifier = node.name.slice(node.name.lastIndexOf("#") + 1);
    if (knownVendorModules.has(specifier.toLowerCase())) {
      return "likely-third-party";
    }
    return "unclassified";
  }

  if (ambiguousFilenames.has(filename)) return "unclassified";
  if (node.source.path.toLowerCase().startsWith("assets/js/")) {
    return applicationScripts.has(filename) || entrypointNames.has(filename)
      ? "application"
      : "unclassified";
  }
  if (applicationRoots.has(pathParts[0]) || pathParts.length === 1) {
    return "application";
  }
  return "unclassified";
}

export function filterArchitectureNodes(
  nodes: Node[],
  filters: Filters,
  showLikelyThirdParty = false,
): Node[] {
  return filterNodes(nodes, filters).filter((node) =>
    showLikelyThirdParty ||
    classifyArchitectureNode(node) !== "likely-third-party",
  );
}

export function likelyThirdPartyNodeIds(nodes: Node[]): Set<string> {
  return new Set(nodes
    .filter((node) => classifyArchitectureNode(node) === "likely-third-party")
    .map((node) => node.id));
}

export function selectInitialArchitectureSeed(nodes: Node[]): string | undefined {
  if (!nodes.length) return undefined;
  const nonVendorNodes = nodes.filter((node) =>
    classifyArchitectureNode(node) !== "likely-third-party",
  );
  const candidates = nonVendorNodes.length ? nonVendorNodes : nodes;
  return [...candidates].sort((left, right) => {
    const leftEntrypoint =
      left.kind === "file" &&
      entrypointNames.has((left.source.path.split("/").at(-1) ?? "").toLowerCase());
    const rightEntrypoint =
      right.kind === "file" &&
      entrypointNames.has((right.source.path.split("/").at(-1) ?? "").toLowerCase());
    const leftPriority = leftEntrypoint ? 4 : rolePriority[left.kind] ?? 100;
    const rightPriority = rightEntrypoint ? 4 : rolePriority[right.kind] ?? 100;
    const classificationPriority = (classification: ComponentClassification) =>
      classification === "application" ? 0 : 1;
    return classificationPriority(classifyArchitectureNode(left)) -
      classificationPriority(classifyArchitectureNode(right)) ||
      leftPriority - rightPriority ||
      left.id.localeCompare(right.id);
  })[0].id;
}
