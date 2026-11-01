import { describe, expect, it } from "vitest";
import { scanSelectedDirectory, type DirectoryFile } from "../src/lib/archaeology/browser-ingestion";
import { allowedSource } from "../src/lib/archaeology/selection";
import { graphFromSources } from "../src/lib/archaeology/scanner-core";

const fixtures = {
  ci3Routes: `<?php
$route['orders/(:num)'] = 'Orders/show/$1';
`,
  ci3Controller: `<?php
class Orders {
  public function show($id) {}
}
`,
  ci4Routes: `<?php
$routes->group('admin', ['filter' => ['auth', 'role']], static function ($collection) {
    $collection->match(['get', 'post'], 'orders/(:num)', 'Orders::show/$1');
    $collection->put('orders/(:num)', 'Orders::show/$1');
    $collection->delete('orders/(:num)', 'Orders::show/$1');
    $collection->get(config('dynamic.route'), 'Orders::show');
    $collection->{$verb}('orders/(:num)', 'Orders::show/$1');
});
`,
  ci4Controller: `<?php
namespace App\\Controllers;
class Orders {
  public function show($id) {}
}
`,
  laravelRoutes: `<?php
use App\\Http\\Controllers\\OrderController;
Route::prefix('admin')->middleware(['auth', 'verified'])->group(static function () {
    Route::match(['get', 'post'], '/orders/{id}', [OrderController::class, 'show']);
});
Route::resource('orders', OrderController::class);
Route::get('/missing', [OrderController::class, 'missing']);
Route::get(config('routes.missing'), [OrderController::class, 'missing']);
`,
  laravelController: `<?php
namespace App\\Http\\Controllers;
class OrderController {
  public function index() {}
  public function create() {}
  public function store() {}
  public function show($id) {}
  public function edit($id) {}
  public function update($id) {}
  public function destroy($id) {}
}
`,
};

const source = (path: string, content: string) => ({ path, content, bytes: Buffer.byteLength(content) });
const browserFile = (relativePath: string, content: string): DirectoryFile => {
  const bytes = new TextEncoder().encode(content);
  return {
    webkitRelativePath: `fixture/${relativePath}`,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
};
const capability = (graph: Awaited<ReturnType<typeof graphFromSources>>, adapter: string) =>
  graph.analysisCapabilities?.phpRouting?.adapters.find(item => item.adapter === adapter);

describe("PHP framework routing adapters", () => {
  it("extracts CodeIgniter 3 routes once, resolves declared actions, and preserves placeholders", async () => {
    const graph = await graphFromSources([
      source("application/config/routes.php", fixtures.ci3Routes),
      source("application/controllers/Orders.php", fixtures.ci3Controller),
    ], []);
    const routes = graph.analysisCapabilities?.phpRouting?.routes.filter(route => route.adapter === "codeigniter-3");
    expect(routes).toHaveLength(1);
    expect(routes?.[0]).toMatchObject({
      path: "/orders/(:num)",
      methods: ["ANY"],
      target: "Orders@show",
      resolution: "resolved",
      resolvedMethod: "application/controllers/Orders.php#show",
      certainty: "observed",
      source: { path: "application/config/routes.php", startLine: 2 },
    });
    expect(graph.nodes.filter(node => node.kind === "route")).toHaveLength(1);
    expect(graph.edges.filter(edge => edge.kind === "routes-to")).toHaveLength(1);
    expect(capability(graph, "codeigniter-3")).toMatchObject({ detection: "confirmed", staticRoutes: 1, status: "analyzed" });
    expect(graph.analysisCapabilities?.backendRouting).toEqual([
      { adapter: "CodeIgniter", status: "partial", staticRoutes: 0, dynamicRoutes: 1 },
    ]);
  });

  it("reads CodeIgniter 4 route groups, method lists, prefixes, filters, and dynamic paths", async () => {
    const graph = await graphFromSources([
      source("app/Config/Routes.php", fixtures.ci4Routes),
      source("app/Controllers/Orders.php", fixtures.ci4Controller),
    ], []);
    const routes = graph.analysisCapabilities?.phpRouting?.routes.filter(route => route.adapter === "codeigniter-4");
    expect(routes).toHaveLength(4);
    expect(routes?.[0]).toMatchObject({
      path: "/admin/orders/(:num)",
      methods: ["GET", "POST"],
      target: "App\\Controllers\\Orders@show",
      middleware: ["auth", "role"],
      resolution: "resolved",
      source: { path: "app/Config/Routes.php", startLine: 3 },
    });
    expect(routes?.find(route => route.resolution === "dynamic")).toMatchObject({ methods: ["GET"] });
    expect(capability(graph, "codeigniter-4")).toMatchObject({
      detection: "confirmed",
      staticRoutes: 3,
      dynamicRoutes: 1,
      status: "partial",
    });
    expect(graph.warnings).toContain("PHP routing analysis is partial for codeigniter-4.");
  });

  it("reports dynamically selected CodeIgniter 4 route methods as partial", async () => {
    const graph = await graphFromSources([
      source("app/Config/Routes.php", `<?php
$routes->{$verb}('/orders', 'Orders::show');
`),
    ], []);
    expect(capability(graph, "codeigniter-4")).toMatchObject({
      detection: "confirmed",
      staticRoutes: 0,
      status: "partial",
    });
  });

  it("handles Laravel multiline route groups, imports, middleware, controller arrays, and supported resources", async () => {
    const routeSource = fixtures.laravelRoutes.replace(
      "Route::match(['get', 'post'], '/orders/{id}', [OrderController::class, 'show']);",
      `Route::match(
        ['get', 'post'],
        '/orders/{id}',
        [OrderController::class, 'show']
      );`,
    );
    const graph = await graphFromSources([
      source("routes/web.php", routeSource),
      source("app/Http/Controllers/OrderController.php", fixtures.laravelController),
    ], []);
    const routes = graph.analysisCapabilities?.phpRouting?.routes.filter(route => route.adapter === "laravel");
    expect(routes).toHaveLength(10);
    expect(routes?.find(route => route.path === "/admin/orders/{id}")).toMatchObject({
      methods: ["GET", "POST"],
      target: "App\\Http\\Controllers\\OrderController@show",
      middleware: ["auth", "verified"],
      resolution: "resolved",
      source: { path: "routes/web.php", startLine: 4 },
    });
    expect(routes?.filter(route => route.certainty === "inferred")).toHaveLength(7);
    expect(routes?.find(route => route.path === "/orders/{order}" && route.methods.includes("DELETE"))).toMatchObject({
      target: "App\\Http\\Controllers\\OrderController@destroy",
      resolution: "resolved",
    });
    expect(routes?.filter(route => route.resolution === "unresolved")).toHaveLength(1);
    expect(graph.nodes.some(node => node.kind === "method" && node.name.endsWith("#missing"))).toBe(false);
    expect(capability(graph, "laravel")).toMatchObject({
      detection: "confirmed",
      staticRoutes: 9,
      dynamicRoutes: 1,
      unresolvedRoutes: 1,
      status: "partial",
    });
  });

  it("marks ambiguous controllers without inventing target methods or graph edges", async () => {
    const graph = await graphFromSources([
      source("routes/api.php", "<?php Route::get('/orders', 'Orders@index');"),
      source("src/First.php", "<?php namespace First; class Orders { public function index() {} }"),
      source("src/Second.php", "<?php namespace Second; class Orders { public function index() {} }"),
    ], []);
    const route = graph.analysisCapabilities?.phpRouting?.routes.find(item => item.adapter === "laravel");
    expect(route).toMatchObject({ resolution: "ambiguous", path: "/orders" });
    expect(graph.edges.some(edge => edge.kind === "routes-to")).toBe(false);
    expect(graph.nodes.filter(node => node.kind === "method" && node.name.endsWith("#index"))).toHaveLength(2);
  });

  it("supports Laravel HTTP verb helpers and route-level prefix and middleware chains", async () => {
    const graph = await graphFromSources([
      source("routes/api.php", `<?php
use App\\Http\\Controllers\\OrderController;
Route::prefix('v2')->middleware('auth')->get('/orders', [OrderController::class, 'show']);
Route::post('/orders', [OrderController::class, 'show']);
Route::put('/orders/{id}', [OrderController::class, 'show']);
Route::patch('/orders/{id}', [OrderController::class, 'show']);
Route::delete('/orders/{id}', [OrderController::class, 'show']);
Route::any('/orders/{id}', [OrderController::class, 'show']);
`),
      source("app/Http/Controllers/OrderController.php", fixtures.laravelController),
    ], []);
    const routes = graph.analysisCapabilities?.phpRouting?.routes.filter(route => route.adapter === "laravel");
    expect(routes?.map(route => route.methods[0])).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"]);
    expect(routes?.[0]).toMatchObject({ path: "/v2/orders", middleware: ["auth"], resolution: "resolved" });
    expect(capability(graph, "laravel")).toMatchObject({ detection: "confirmed", staticRoutes: 6, status: "analyzed" });
  });

  it("keeps dynamic route declarations and unsupported resource mappings partial", async () => {
    const graph = await graphFromSources([
      source("routes/web.php", `<?php
Route::get($path, function () {});
Route::resource('news', NewsController::class);
`),
    ], []);
    const routes = graph.analysisCapabilities?.phpRouting?.routes ?? [];
    expect(routes).toHaveLength(2);
    expect(routes.some(route => route.resolution === "dynamic")).toBe(true);
    expect(routes.some(route => route.resolution === "ambiguous")).toBe(true);
    expect(capability(graph, "laravel")?.status).toBe("partial");
  });

  it("does not turn parser-recovered declarations into route evidence", async () => {
    const graph = await graphFromSources([
      source("routes/web.php", "<?php Route::get('/orders', [OrdersController::class, 'index'];"),
    ], []);
    expect(graph.analysisCapabilities?.phpRouting?.routes).toEqual([]);
    expect(capability(graph, "laravel")).toMatchObject({ detection: "probable", status: "partial" });
  });

  it("reports unknown framework detection without treating generic PHP as a framework", async () => {
    const graph = await graphFromSources([
      source("src/Invoice.php", "<?php class Invoice { public function save() {} }"),
    ], []);
    expect(graph.analysisCapabilities?.phpRouting?.adapters.map(item => item.detection)).toEqual(["unknown", "unknown", "unknown"]);
    expect(graph.analysisCapabilities?.phpRouting?.routes).toEqual([]);
  });

  it("reports probable detection for route syntax outside a canonical framework manifest", async () => {
    const graph = await graphFromSources([
      source("src/custom.php", "<?php Route::get('/orders', 'Orders@index');"),
    ], []);
    expect(capability(graph, "laravel")).toMatchObject({ detection: "probable", status: "partial" });
    expect(graph.analysisCapabilities?.phpRouting?.routes).toHaveLength(1);
  });

  it("allows only named route manifests while retaining secret and vendor exclusions", () => {
    for (const path of ["application/config/routes.php", "app/Config/Routes.php", "routes/web.php", "routes/api.php"]) {
      expect(allowedSource(path)).toBe(true);
    }
    for (const path of [
      "app/config/database.php",
      "routes/credentials.php",
      "routes/.env.php",
      "vendor/routes/web.php",
      "routes/custom.php",
      "app/Config/Database.php",
    ]) expect(allowedSource(path)).toBe(false);
  });

  it("produces equivalent route evidence in browser ingestion and server graph construction", async () => {
    const files = [
      browserFile("routes/web.php", fixtures.laravelRoutes),
      browserFile("app/Http/Controllers/OrderController.php", fixtures.laravelController),
    ];
    const browser = await scanSelectedDirectory(files);
    const server = await graphFromSources(files.map(file => {
      const path = file.webkitRelativePath.split("/").slice(1).join("/");
      const content = path.endsWith("web.php") ? fixtures.laravelRoutes : fixtures.laravelController;
      return source(path, content);
    }), []);
    expect(browser.graph.analysisCapabilities?.phpRouting).toEqual(server.analysisCapabilities?.phpRouting);
    expect(browser.graph.nodes.filter(node => node.kind === "route")).toEqual(server.nodes.filter(node => node.kind === "route"));
  });
});
