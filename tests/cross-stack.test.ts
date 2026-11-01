import { describe, expect, it } from "vitest";
import { scanSelectedDirectory, type DirectoryFile } from "../src/lib/archaeology/browser-ingestion";
import { graphFromSources } from "../src/lib/archaeology/scanner-core";
import { parseGraph } from "../src/lib/architecture/graph";

const source = (path: string, content: string) => ({ path, content, bytes: Buffer.byteLength(content) });
const browserFile = (path: string, content: string): DirectoryFile => {
  const bytes = new TextEncoder().encode(content);
  return {
    webkitRelativePath: `fixture/${path}`,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
};
const matches = (graph: Awaited<ReturnType<typeof graphFromSources>>) => graph.analysisCapabilities?.crossStack?.matches ?? [];

describe("cross-stack frontend-to-PHP tracing", () => {
  const angularSources = [
    source("src/orders.js", `angular.module("shop", []).controller("OrdersCtrl", function ($http) {
  $http.get("/index.php/api/orders/42");
});`),
    source("application/config/routes.php", `<?php
$route['api/orders/(:num)'] = 'Orders/show/$1';
`),
    source("application/controllers/Orders.php", `<?php
namespace App\\Controllers;
use App\\Services\\OrderService;
class Orders {
  private OrderService $orders;
  public function show() {
    $this->orders->find(42);
  }
}`),
    source("application/services/OrderService.php", `<?php
namespace App\\Services;
class OrderService {
  public function find($id) {}
}`),
  ];

  it("correlates AngularJS requests through parameterized CodeIgniter routes to observed PHP calls", async () => {
    const graph = await graphFromSources(angularSources, []);
    const match = matches(graph)[0];
    expect(match).toMatchObject({
      status: "parameterized",
      method: "GET",
      controllerActionResolved: true,
      frontendSource: { path: "src/orders.js", startLine: 2 },
      backendSources: [{ path: "application/config/routes.php", startLine: 2 }],
    });
    const route = graph.nodes.find(node => node.kind === "route" && node.source.path === "application/config/routes.php")!;
    const controllerMethod = graph.nodes.find(node => node.kind === "method" && node.name.endsWith("Orders.php#show"))!;
    const serviceMethod = graph.nodes.find(node => node.kind === "method" && node.name.endsWith("OrderService.php#find"))!;
    const angularController = graph.nodes.find(node => node.kind === "controller" && node.name.endsWith("#OrdersCtrl"))!;
    expect(graph.edges.some(edge => edge.kind === "calls-endpoint" && edge.from === angularController.id && edge.to === match.endpointId)).toBe(true);
    expect(graph.edges.find(edge => edge.kind === "calls-route" && edge.to === route.id)).toMatchObject({
      from: match.endpointId,
      certainty: "inferred",
      source: { path: "src/orders.js", startLine: 2 },
    });
    expect(graph.edges.some(edge => edge.kind === "routes-to" && edge.to === controllerMethod.id && edge.certainty === "observed")).toBe(true);
    expect(graph.edges.find(edge => edge.kind === "calls-php-method" && edge.from === controllerMethod.id && edge.to === serviceMethod.id)).toMatchObject({
      certainty: "observed",
      source: { path: "application/controllers/Orders.php", startLine: 7 },
    });
    expect(graph.analysisCapabilities?.crossStack?.phpMethodCalls.observed).toBe(1);
    expect(parseGraph(JSON.stringify(graph))).toEqual(graph);
  });

  it("keeps browser and server cross-stack output identical", async () => {
    const browser = await scanSelectedDirectory(angularSources.map(file => browserFile(file.path, file.content)));
    const server = await graphFromSources(angularSources, []);
    expect(browser.graph.analysisCapabilities?.crossStack).toEqual(server.analysisCapabilities?.crossStack);
    expect(browser.graph.edges).toEqual(server.edges);
  });

  it("correlates React fetch with Laravel parameters and rejects incompatible methods", async () => {
    const sources = [
      source("src/orders.tsx", `export function save() {
  return fetch("/api/orders/42", { method: "POST" });
}`),
      source("routes/api.php", `<?php
use App\\Http\\Controllers\\OrderController;
Route::post('/api/orders/{order}', [OrderController::class, 'update']);
`),
      source("app/Http/Controllers/OrderController.php", `<?php
namespace App\\Http\\Controllers;
class OrderController { public function update($order) {} }
`),
    ];
    const graph = await graphFromSources(sources, []);
    expect(matches(graph)[0]).toMatchObject({ status: "parameterized", method: "POST", controllerActionResolved: true });
    expect(graph.edges.some(edge => edge.kind === "calls-route" && edge.certainty === "inferred")).toBe(true);
    const saveFunction = graph.nodes.find(node => node.kind === "function" && node.name.endsWith("#save"))!;
    expect(graph.edges.some(edge => edge.kind === "calls-endpoint" && edge.from === saveFunction.id)).toBe(true);

    const mismatched = await graphFromSources([
      source("src/orders.tsx", `fetch("/api/orders/42");`),
      sources[1],
      sources[2],
    ], []);
    expect(matches(mismatched)[0]).toMatchObject({
      status: "unresolved",
      reason: "method-mismatch",
      method: "GET",
      backendSources: [{ path: "routes/api.php", startLine: 3 }],
    });
    expect(mismatched.edges.some(edge => edge.kind === "calls-route")).toBe(false);
  });

  it("reports exact static paths and leaves arbitrary backend patterns unresolved", async () => {
    const graph = await graphFromSources([
      source("src/api.js", `fetch("/api/health");
fetch("/api/items/123");`),
      source("application/config/routes.php", `<?php
$route['api/health'] = 'Health/index';
$route['api/items/*'] = 'Items/show';
`),
    ], []);
    expect(matches(graph)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "exact", frontendSource: expect.objectContaining({ path: "src/api.js", startLine: 1 }) }),
      expect.objectContaining({ status: "unresolved", reason: "unsupported-backend-pattern", frontendSource: expect.objectContaining({ path: "src/api.js", startLine: 2 }) }),
    ]));
    expect(graph.edges.filter(edge => edge.kind === "calls-route")).toHaveLength(1);
  });

  it("reports exact paths, ambiguous backend declarations, and dynamic frontend URLs separately", async () => {
    const graph = await graphFromSources([
      source("src/api.js", "fetch('/api/health');\nfetch(`/api/orders/${orderId}`);"),
      source("application/config/routes.php", `<?php
$route['api/health'] = 'Health/index';
$route['api/orders/(:num)'] = 'Orders/show';
`),
      source("routes/web.php", `<?php
use App\\Http\\Controllers\\HealthController;
Route::get('/api/health', [HealthController::class, 'index']);
`),
      source("app/Http/Controllers/HealthController.php", `<?php
namespace App\\Http\\Controllers;
class HealthController { public function index() {} }
`),
    ], []);
    expect(matches(graph)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "ambiguous", reason: "multiple-routes", totalCandidateCount: 2 }),
      expect.objectContaining({ status: "unresolved", reason: "dynamic-frontend-path" }),
    ]));
    expect(matches(graph).some(match => match.status === "exact")).toBe(false);
    expect(graph.edges.some(edge => edge.kind === "calls-route")).toBe(false);
  });

  it("links a route declaration without implying that a missing controller action resolves", async () => {
    const graph = await graphFromSources([
      source("src/orders.js", `fetch("/api/missing");`),
      source("routes/api.php", `<?php
use App\\Http\\Controllers\\OrderController;
Route::get('/api/missing', [OrderController::class, 'missing']);
`),
      source("app/Http/Controllers/OrderController.php", `<?php
namespace App\\Http\\Controllers;
class OrderController { public function index() {} }
`),
    ], []);
    expect(matches(graph)[0]).toMatchObject({ status: "exact", controllerActionResolved: false });
    const route = graph.nodes.find(node => node.kind === "route")!;
    expect(graph.edges.some(edge => edge.kind === "calls-route" && edge.to === route.id)).toBe(true);
    expect(graph.edges.some(edge => edge.kind === "routes-to" && edge.from === route.id)).toBe(false);
  });
});
