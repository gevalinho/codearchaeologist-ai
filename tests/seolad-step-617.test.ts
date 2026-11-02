import { describe, expect, it } from "vitest";
import { scanSelectedDirectory, type DirectoryFile } from "../src/lib/archaeology/browser-ingestion";
import { scanRepository } from "../src/lib/archaeology/scanner";
import { allowedSource } from "../src/lib/archaeology/selection";
import { graphFromSources } from "../src/lib/archaeology/scanner-core";
import { parseGraph } from "../src/lib/architecture/graph";
import { analyzeArchitectureHealth } from "../src/lib/architecture/architecture-health";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const source = (path: string, content: string) => ({ path, content, bytes: Buffer.byteLength(content) });
const browserFile = (relativePath: string, content: string): DirectoryFile => {
  const bytes = new TextEncoder().encode(content);
  return {
    webkitRelativePath: `fixture/${relativePath}`,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
};

const angularWrapper = `app.service('postForm', ['Upload', function (Upload) {
  this.postMultiForm = function (data, url) {
    return Upload.upload({ url: url, data: data });
  };
}]);`;
const frontendCall = (url: string) => `app.controller('resultCtr', function ($scope) {
  postForm.postMultiForm({}, ${url});
});`;
const phpRoute = `<?php
$route['gett/(:any)'] = 'getdatactrl/getdata/$1';
`;
const phpController = `<?php
class Getdatactrl {
  public $get_model;
  public function getData($con) {
    switch ($con) {
      case "getresultinput":
        $this->getResultinput();
        break;
      case "getcollatedresultinput":
        $this->getCollatedResultinput();
        break;
    }
  }
  public function getResultinput() {
    $this->get_model->complexQuery('select * from results');
  }
  public function getCollatedResultinput() {}
}`;
const phpModel = `<?php
class Get_model {
  public function complexQuery($query) {}
}`;

describe("Step 617 Seolad evidence-gap regressions", () => {
  it("traces a uniquely forwarded AngularJS upload URL through CI3 parameter dispatch", async () => {
    const sources = [
      source("assets/js/angular.main.js", frontendCall("'index.php/gett/getresultinput'")),
      source("assets/js/services.js", angularWrapper),
      source("application/config/routes.php", phpRoute),
      source("application/controllers/Getdatactrl.php", phpController),
      source("application/models/Get_model.php", phpModel),
    ];
    const graph = await graphFromSources(sources, []);
    expect(analyzeArchitectureHealth(graph).findings).toEqual([]);
    const endpoint = graph.nodes.find(node => node.kind === "endpoint" && node.name === "index.php/gett/getresultinput")!;
    const route = graph.nodes.find(node => node.kind === "route" && node.name.includes("gett/(:any)"))!;
    const getData = graph.nodes.find(node => node.kind === "method" && node.name.endsWith("Getdatactrl.php#getData"))!;
    const resultHandler = graph.nodes.find(node => node.kind === "method" && node.name.endsWith("Getdatactrl.php#getResultinput"))!;
    const modelMethod = graph.nodes.find(node => node.kind === "method" && node.name.endsWith("Get_model.php#complexQuery"))!;
    const wrapper = graph.analysisCapabilities?.crossStack?.matches[0];

    expect(endpoint.source).toMatchObject({ path: "assets/js/angular.main.js", startLine: 2 });
    expect(graph.edges.find(edge => edge.kind === "calls-endpoint" && edge.to === endpoint.id)).toMatchObject({
      from: "controller:assets/js/angular.main.js#resultCtr",
      source: { path: "assets/js/angular.main.js", startLine: 2 },
      certainty: "observed",
    });
    expect(wrapper).toMatchObject({
      status: "parameterized",
      frontendSource: { path: "assets/js/angular.main.js", startLine: 2 },
      wrapperSource: { path: "assets/js/services.js", startLine: 2 },
    });
    expect(wrapper).not.toHaveProperty("method");
    expect(graph.edges.find(edge => edge.kind === "calls-route" && edge.to === route.id)).toMatchObject({
      from: endpoint.id,
      certainty: "inferred",
    });
    expect(graph.edges.find(edge => edge.kind === "routes-to" && edge.from === route.id && edge.to === getData.id)).toMatchObject({
      source: { path: "application/config/routes.php", startLine: 2 },
      certainty: "observed",
    });
    expect(graph.edges.find(edge => edge.kind === "binds-route-parameter" && edge.from === route.id && edge.to === getData.id)).toMatchObject({
      source: { path: "application/config/routes.php", startLine: 2 },
      certainty: "observed",
      method: "codeigniter-static-parameter-v1",
    });
    expect(graph.edges.find(edge => edge.kind === "dispatches-to" && edge.from === getData.id && edge.to === resultHandler.id)).toMatchObject({
      source: { path: "application/controllers/Getdatactrl.php", startLine: 7 },
      certainty: "observed",
      method: "php-switch-route-dispatch-v1",
    });
    expect(graph.edges.find(edge => edge.kind === "calls-php-method" && edge.from === getData.id && edge.to === resultHandler.id)).toMatchObject({
      source: { path: "application/controllers/Getdatactrl.php", startLine: 7 },
      certainty: "observed",
      method: "php-same-class-call-v1",
    });
    expect(graph.edges.find(edge => edge.kind === "calls-model-method" && edge.to === modelMethod.id)).toMatchObject({
      certainty: "inferred",
      source: { path: "application/controllers/Getdatactrl.php", startLine: 15 },
    });
    expect(graph.analysisCapabilities?.phpRouting?.routes.find(item => item.adapter === "codeigniter-3")).toMatchObject({
      parameterBindings: [{ routeParameter: 1, argument: 1 }],
    });
    expect(parseGraph(JSON.stringify(graph))).toEqual(graph);
  });

  it("keeps wrapper methods unknown, reports dynamic URLs, and rejects ambiguous or transformed wrappers", async () => {
    const dynamicSources = [
      source("src/calls.js", frontendCall("runtimeUrl")),
      source("assets/js/services.js", angularWrapper),
      source("application/config/routes.php", phpRoute),
    ];
    const dynamic = await graphFromSources(dynamicSources, []);
    expect(dynamic.analysisCapabilities?.crossStack?.matches[0]).toMatchObject({
      status: "unresolved",
      reason: "dynamic-frontend-path",
      wrapperSource: { path: "assets/js/services.js", startLine: 2 },
    });
    expect(dynamic.analysisCapabilities?.crossStack?.matches[0]).not.toHaveProperty("method");

    const ambiguous = await graphFromSources([
      source("src/calls.js", frontendCall("'index.php/gett/getresultinput'")),
      source("assets/js/services.js", angularWrapper),
      source("src/duplicate-service.js", angularWrapper),
    ], []);
    expect(ambiguous.nodes.some(node => node.kind === "endpoint")).toBe(false);
    expect(ambiguous.warnings).toContain("AngularJS HTTP wrapper ambiguous-wrapper at src/calls.js:2.");

    const transformed = await graphFromSources([
      source("src/calls.js", frontendCall("'index.php/gett/getresultinput'")),
      source("assets/js/services.js", angularWrapper.replace("url: url", "url: prefix + url")),
    ], []);
    expect(transformed.nodes.some(node => node.kind === "endpoint")).toBe(false);
    expect(transformed.warnings).toContain("AngularJS HTTP wrapper unsupported-wrapper at src/calls.js:2.");
  });

  it("validates repeated endpoint calls while preserving each exact cross-stack call-site reference", async () => {
    const graph = await graphFromSources([
      source("src/calls.js", `fetch('/gett/getresultinput');`),
      source("src/second-call.js", `fetch('/gett/getresultinput');`),
      source("application/config/routes.php", phpRoute),
      source("application/controllers/Getdatactrl.php", phpController),
    ], []);
    const matches = graph.analysisCapabilities?.crossStack?.matches ?? [];

    expect(matches.map(match => match.frontendSource.path)).toEqual(["src/calls.js", "src/second-call.js"]);
    expect(matches[0].endpointId).toBe(matches[1].endpointId);
    expect(parseGraph(JSON.stringify(graph))).toEqual(graph);
  });

  it("preserves static route-parameter evidence but does not invent a dispatch for missing or ambiguous cases", async () => {
    const missingCase = await graphFromSources([
      source("src/calls.js", `fetch('/gett/getresultinput');`),
      source("application/config/routes.php", phpRoute),
      source("application/controllers/Getdatactrl.php", phpController.replace('"getresultinput"', '"different-operation"')),
    ], []);
    const route = missingCase.nodes.find(node => node.kind === "route" && node.name.includes("gett/(:any)"))!;
    const getData = missingCase.nodes.find(node => node.kind === "method" && node.name.endsWith("#getData"))!;
    expect(missingCase.edges.some(edge => edge.kind === "binds-route-parameter" && edge.from === route.id && edge.to === getData.id)).toBe(true);
    expect(missingCase.edges.some(edge => edge.kind === "dispatches-to")).toBe(false);
    expect(missingCase.warnings).toContain("Static CodeIgniter route dispatch unresolved at src/calls.js:1.");

    const ambiguousCase = await graphFromSources([
      source("src/calls.js", `fetch('/gett/getresultinput');`),
      source("application/config/routes.php", phpRoute),
      source("application/controllers/Getdatactrl.php", phpController.replace(
        'case "getcollatedresultinput":',
        'case "getresultinput":\n        $this->getCollatedResultinput();\n        break;\n      case "getcollatedresultinput":',
      )),
    ], []);
    expect(ambiguousCase.edges.some(edge => edge.kind === "dispatches-to")).toBe(false);
    expect(ambiguousCase.warnings).toContain("Static CodeIgniter route dispatch ambiguous at src/calls.js:1.");

    const invalidSubstitution = await graphFromSources([
      source("src/calls.js", `fetch('/gett/getresultinput');`),
      source("application/config/routes.php", `<?php
$route['gett/(:any)'] = 'getdatactrl/getdata/$2';
`),
      source("application/controllers/Getdatactrl.php", phpController),
    ], []);
    const invalidRoute = invalidSubstitution.analysisCapabilities?.phpRouting?.routes.find(route =>
      route.adapter === "codeigniter-3" && route.source.path === "application/config/routes.php");
    expect(invalidRoute?.resolution).toBe("ambiguous");
    expect(invalidRoute?.parameterBindings).toBeUndefined();
    expect(invalidSubstitution.edges.some(edge => edge.kind === "binds-route-parameter" || edge.kind === "dispatches-to")).toBe(false);
    expect(invalidSubstitution.warnings).toContain("Static CodeIgniter route dispatch unresolved at src/calls.js:1.");
  });

  it("uses the same bounded wrapper evidence in browser and server graph generation", async () => {
    const sources = [
      source("assets/js/angular.main.js", frontendCall("'index.php/gett/getresultinput'")),
      source("assets/js/services.js", angularWrapper),
      source("application/config/routes.php", phpRoute),
      source("application/controllers/Getdatactrl.php", phpController),
    ];
    const browser = await scanSelectedDirectory(sources.map(item => browserFile(item.path, item.content)));
    const server = await graphFromSources(sources, []);
    expect(browser.graph.analysisCapabilities?.crossStack).toEqual(server.analysisCapabilities?.crossStack);
    expect(browser.graph.analysisCapabilities?.javascriptTypescript?.uiRouterStates).toEqual(server.analysisCapabilities?.javascriptTypescript?.uiRouterStates);
    expect(browser.graph.edges).toEqual(server.edges);
  });

  it("skips only the recognized oversized ECharts bundle and records partial coverage", async () => {
    expect(allowedSource("assets/js/echarts.js")).toBe(false);
    expect(allowedSource("assets/js/application.js")).toBe(true);
    const content = "angular.module('demo', []);";
    const oversized: DirectoryFile = {
      webkitRelativePath: "fixture/assets/js/echarts.js",
      size: 2 * 1024 * 1024 + 1,
      arrayBuffer: async () => { throw new Error("recognized bundle must not be read"); },
    };
    const browser = await scanSelectedDirectory([browserFile("assets/js/main.js", content), oversized]);
    expect(browser.graph.sourceCoverage).toEqual({
      eligibleFiles: 1,
      selectedFiles: 1,
      omittedFiles: 0,
      analyzedFiles: 1,
      skippedFiles: 1,
      partial: true,
    });
    expect(browser.graph.warnings).toContain("Skipped recognized third-party bundle (recognized-third-party-bundle): assets/js/echarts.js");
    expect(browser.graph.nodes.some(node => node.name.includes("echarts.js"))).toBe(false);

    const root = await mkdtemp(path.join(tmpdir(), "recognized-bundle-scan-"));
    try {
      await mkdir(path.join(root, "assets/js"), { recursive: true });
      await writeFile(path.join(root, "assets/js/main.js"), content);
      await writeFile(path.join(root, "assets/js/echarts.js"), "x".repeat(2 * 1024 * 1024 + 1));
      const local = await scanRepository(root);
      expect(local.sourceCoverage).toEqual(browser.graph.sourceCoverage);
      expect(local.warnings).toContain("Skipped recognized third-party bundle (recognized-third-party-bundle): assets/js/echarts.js");
      expect(local.nodes).toEqual(browser.graph.nodes);
      expect(local.edges).toEqual(browser.graph.edges);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
