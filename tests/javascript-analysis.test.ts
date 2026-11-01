import { describe, expect, it } from "vitest";
import { allowedSource } from "../src/lib/archaeology/selection";
import { prepareDirectorySelection, scanSelectedDirectory, type DirectoryFile } from "../src/lib/archaeology/browser-ingestion";
import { graphFromSources } from "../src/lib/archaeology/scanner-core";
import { parseGraph } from "../src/lib/architecture/graph";

const file = (relative: string, content: string): DirectoryFile => {
  const bytes = new TextEncoder().encode(content);
  return { webkitRelativePath: `fixture/${relative}`, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) };
};
const source = (path: string, content: string) => ({ path, content, bytes: Buffer.byteLength(content) });
const fixtures = [
  file("src/main.js", `import { Home } from "./Home";
export function loadUsers() { return fetch("/index.php/api/users"); }
export const dynamicLoad = (url) => fetch(url);
`),
  file("src/Home.jsx", `import { Routes, Route } from "react-router-dom";
export function Home() { return <main>Users</main>; }
export function App() { return <Routes><Route path="/home" element={<Home />} /></Routes>; }
`),
  file("src/Users.ts", `export type User = { id: string };
export async function getUser(id: string) { return fetch("/api/users/" + id); }
`),
  file("src/UsersView.tsx", `import type { User } from "./Users";
export function UsersView(props: { user: User }) { return <section>{props.user.id}</section>; }
`),
  file("assets/js/angular.main.js", `angular.module("legacy", []).config(["$routeProvider", function ($routeProvider) {
  $routeProvider.when("/legacy", { controller: "LegacyCtrl" });
}]).controller("LegacyCtrl", function ($scope, $http) {
  $http.get("index.php/api/users");
});
`),
  file("src/DynamicRoutes.tsx", `import { Route, Routes } from "react-router";
export function DynamicRoutes({ routePath }) { return <Routes><Route path={routePath} /></Routes>; }
`),
  file("src/VueRoutes.ts", `import { createRouter } from "vue-router";
export const router = createRouter({ routes: [] });
`),
  file("application/config/routes.php", `<?php
$route['api/users'] = 'Users/show';
`),
  file("application/controllers/Users.php", `<?php
class Users {
  public function show() {}
}
`),
];

describe("framework-agnostic JavaScript and TypeScript scanning", () => {
  it("selects safe JS/TS application sources while excluding build and sensitive paths", () => {
    for (const path of ["src/main.js", "src/App.jsx", "app/page.tsx", "pages/index.ts", "assets/js/custom.js", "application/config/routes.php", "routes/web.php"]) expect(allowedSource(path)).toBe(true);
    for (const path of ["node_modules/pkg/index.js", "src/.env.ts", "src/secret-key.ts", "src/main.min.js", "config/routes.php", "routes/custom.php", "public/app.js"]) expect(allowedSource(path)).toBe(false);
    const prepared = prepareDirectorySelection(fixtures);
    expect(prepared.progress.eligibleFiles).toBe(fixtures.length);
  });

  it("extracts syntax-aware modules, exports, functions, components, imports, and evidence-backed routes", async () => {
    const result = await scanSelectedDirectory(fixtures, { scannedAt: new Date("2026-01-01T00:00:00Z") });
    const graph = parseGraph(result.graphJson);
    const node = (kind: string, name: string) => graph.nodes.find(item => item.kind === kind && item.name.includes(name));
    const edge = (kind: string, from: string, to: string) => graph.edges.find(item => item.kind === kind && item.from === from && item.to === to);

    expect(node("component", "Home")).toBeDefined();
    expect(node("component", "UsersView")).toBeDefined();
    expect(node("function", "getUser")).toBeDefined();
    expect(graph.nodes.filter(item => item.kind === "module").map(item => item.name)).toContain("src/main.js#./Home");
    expect(graph.edges.some(item => item.kind === "exports" && item.from === "file:src/main.js")).toBe(true);
    expect(graph.edges.some(item => item.kind === "imports" && item.from === "file:src/main.js")).toBe(true);

    const homeRoute = node("route", "/home")!;
    const homeComponent = graph.nodes.find(item => item.kind === "component" && item.name.endsWith("#Home"))!;
    expect(edge("routes-to", homeRoute.id, homeComponent.id)?.certainty).toBe("observed");
    const angularRoute = node("route", "/legacy")!;
    expect(angularRoute).toBeDefined();
    expect(graph.edges.some(item => item.kind === "routes-to" && item.from === angularRoute.id && item.certainty === "observed")).toBe(true);

    const endpoint = node("endpoint", "index.php/api/users")!;
    const backendRoute = node("route", "application/config/routes.php#api/users")!;
    expect(edge("calls-route", endpoint.id, backendRoute.id)?.certainty).toBe("inferred");
    expect(graph.nodes.some(item => item.kind === "method" && item.name.endsWith("Users.php#show"))).toBe(true);
    expect(graph.analysisCapabilities?.javascriptTypescript).toMatchObject({ parser: "babel", analyzedFiles: 7, unsupportedFiles: 0 });
    expect(graph.analysisCapabilities?.javascriptTypescript?.routingAdapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "AngularJS", status: "analyzed", staticRoutes: 1 }),
      expect.objectContaining({ adapter: "React Router", status: "partial", staticRoutes: 1, dynamicRoutes: 1 }),
      expect.objectContaining({ adapter: "Vue Router", status: "unsupported" }),
    ]));
    expect(graph.analysisCapabilities?.backendRouting).toEqual([
      expect.objectContaining({ adapter: "CodeIgniter", status: "analyzed", staticRoutes: 1 }),
    ]);
    expect(graph.limitations.some(item => item.includes("Unsupported routing adapters: Vue Router"))).toBe(true);
    expect(graph.limitations.some(item => item.includes("Partially analyzed routing adapters: React Router"))).toBe(true);
  });

  it("reports syntax failures and dynamic API targets instead of claiming complete analysis", async () => {
    const source = (path: string, content: string) => ({ path, content, bytes: Buffer.byteLength(content) });
    const sources = [
      source("src/valid.ts", "export function callApi(url: string) { return fetch(url); }"),
      source("src/broken.tsx", "export const Component = () => <div>"),
    ];
    const graph = await graphFromSources(sources, []);
    expect(graph.analysisCapabilities?.javascriptTypescript).toMatchObject({ analyzedFiles: 1, unsupportedFiles: 1 });
    expect(graph.nodes.some(item => item.kind === "http-call" && item.name.includes("dynamic HTTP request"))).toBe(true);
    expect(graph.warnings).toContain("JavaScript/TypeScript syntax or analysis limit not supported: src/broken.tsx");
    expect(parseGraph(JSON.stringify(graph))).toEqual(graph);
  });

  it("recognizes aliased Axios calls and avoids linking ambiguous route targets", async () => {
    const source = (path: string, content: string) => ({ path, content, bytes: Buffer.byteLength(content) });
    const sources = [
      source("src/App.jsx", `import client from "axios";
import { Home } from "./Home";
import { Routes, Route } from "react-router-dom";
export function App() { client.get("/api/users"); return <Routes><Route path="/home" element={<Home />} /></Routes>; }`),
      source("src/one/Home.jsx", "export function Home() { return <main>One</main>; }"),
      source("src/two/Home.jsx", "export function Home() { return <main>Two</main>; }"),
    ];
    const graph = await graphFromSources(sources, []);
    expect(graph.nodes.some(item => item.kind === "endpoint" && item.name === "/api/users")).toBe(true);
    const route = graph.nodes.find(item => item.kind === "route" && item.name === "/home")!;
    expect(graph.edges.some(item => item.kind === "routes-to" && item.from === route.id)).toBe(false);
    expect(graph.analysisCapabilities?.javascriptTypescript?.routingAdapters).toContainEqual(
      expect.objectContaining({ adapter: "React Router", status: "partial" }),
    );

    const linkedGraph = await graphFromSources([
      source("src/Routes.jsx", `import { Home as Landing } from "./views/Home";
import { Routes, Route } from "react-router-dom";
export function AppRoutes() { return <Routes><Route path="/linked" element={<Landing />} /></Routes>; }`),
      source("src/views/Home.jsx", "export function Home() { return <main>Home</main>; }"),
      source("src/other/Home.jsx", "export function Home() { return <main>Other</main>; }"),
    ], []);
    const linkedRoute = linkedGraph.nodes.find(item => item.kind === "route" && item.name === "/linked")!;
    expect(linkedGraph.edges.some(item => item.kind === "routes-to" && item.from === linkedRoute.id && item.to === "component:src/views/Home.jsx#Home")).toBe(true);
  });

  it("extracts deep AngularJS UI-Router state fields with exact source references", async () => {
    const deepExpression = `${"[".repeat(280)}0${"]".repeat(280)}`;
    const graph = await graphFromSources([
      source("assets/js/routes.js", `app.config(function ($stateProvider) {
  $stateProvider.state('seo.dashboard.results', {
    url: '/results',
    templateUrl: 'index.php/page/adminresults',
    controller: 'resultCtr'
  });
  const unrelated = ${deepExpression};
});`),
      source("assets/js/angular.main.js", `app.controller('resultCtr', function ($scope) {});`),
    ], []);
    const states = graph.analysisCapabilities?.javascriptTypescript?.uiRouterStates;
    expect(states).toEqual([expect.objectContaining({
      state: "seo.dashboard.results",
      url: "/results",
      templateUrl: "index.php/page/adminresults",
      controller: "resultCtr",
      source: { path: "assets/js/routes.js", startLine: 2, endLine: 6 },
      stateNameSource: { path: "assets/js/routes.js", startLine: 2, endLine: 2 },
      templateSource: { path: "assets/js/routes.js", startLine: 4, endLine: 4 },
      controllerSource: { path: "assets/js/routes.js", startLine: 5, endLine: 5 },
    })]);
    const stateRoute = graph.nodes.find(item => item.kind === "route" && item.name === "seo.dashboard.results");
    const controller = graph.nodes.find(item => item.kind === "controller" && item.name.endsWith("#resultCtr"));
    expect(stateRoute).toBeDefined();
    expect(graph.edges.find(item => item.kind === "routes-to" && item.from === stateRoute?.id && item.to === controller?.id)?.certainty).toBe("observed");
    expect(graph.warnings).toContain("JavaScript/TypeScript analysis is partial (ast-depth-limit): assets/js/routes.js");
    expect(parseGraph(JSON.stringify(graph))).toEqual(graph);
  });

  it("retains route evidence and marks route-focused extraction partial at its own resource boundary", async () => {
    const unrelatedDeclarations = Array.from({ length: 11_000 }, (_, index) => `  const unrelated${index} = ${index};`).join("\n");
    const graph = await graphFromSources([
      source("assets/js/routes.js", `app.config(function ($stateProvider) {
${unrelatedDeclarations}
  $stateProvider.state('results', { url: '/results', templateUrl: 'results.html' });
});`),
    ], []);
    expect(graph.analysisCapabilities?.javascriptTypescript?.uiRouterStates).toEqual([
      expect.objectContaining({ state: "results", url: "/results", templateUrl: "results.html" }),
    ]);
    expect(graph.analysisCapabilities?.javascriptTypescript?.routingAdapters).toContainEqual(
      expect.objectContaining({ adapter: "AngularJS", status: "partial", staticRoutes: 1 }),
    );
    expect(graph.warnings).toContain("JavaScript/TypeScript analysis is partial (ast-node-limit): assets/js/routes.js");
  });

  it("retains deterministic graph output when directory picker order changes", async () => {
    const first = await scanSelectedDirectory(fixtures);
    const second = await scanSelectedDirectory([...fixtures].reverse());
    expect(first.graph).toEqual(second.graph);
  });
});
