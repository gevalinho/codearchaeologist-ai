import { describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/lib/ai/model-provider";
import { scanSelectedDirectory, type DirectoryFile } from "../src/lib/archaeology/browser-ingestion";
import { graphFromSources } from "../src/lib/archaeology/scanner-core";
import type { Graph } from "../src/lib/archaeology/scanner";
import { parseGraph, sourceReference } from "../src/lib/architecture/graph";
import { parseRepositoryAnswer } from "../src/lib/architecture/ai-repository-chat";
import { discoverSourceTraces } from "../src/lib/architecture/source-traces";
import { executeInvestigationTool, parseInvestigationToolCall } from "../src/lib/architecture/investigation-tools";
import { runAutonomousInvestigation } from "../src/lib/architecture/autonomous-investigation";

const source = (path: string, content: string) => ({ path, content, bytes: Buffer.byteLength(content) });
const browserFile = (relativePath: string, content: string): DirectoryFile => {
  const bytes = new TextEncoder().encode(content);
  return {
    webkitRelativePath: `fixture/${relativePath}`,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
};
const wrapper = `app.service('postForm', ['Upload', function (Upload) {
  this.postMultiForm = function (data, url) {
    return Upload.upload({ url: url, data: data });
  };
}]);`;
const frontend = `app.controller('resultCtr', function ($scope) {
  postForm.postMultiForm({}, 'index.php/gett/getresultinput');
  postForm.postMultiForm({}, 'index.php/gett/getcollatedresultinput');
});`;
const stateRoutes = `app.config(function ($stateProvider) {
  $stateProvider.state('seo.dashboard.results', {
    url: '/results',
    templateUrl: 'index.php/page/adminresults',
    controller: 'resultCtr'
  });
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
  public function getCollatedResultinput() {
    $this->get_model->complexQuery('select * from results');
  }
}`;
const phpModel = `<?php
class Get_model {
  public function complexQuery($query) {}
}`;
const completeSources = [
  source("assets/js/routes.js", stateRoutes),
  source("assets/js/angular.main.js", frontend),
  source("assets/js/services.js", wrapper),
  source("application/config/routes.php", phpRoute),
  source("application/controllers/Getdatactrl.php", phpController),
  source("application/models/Get_model.php", phpModel),
];

describe("bounded source-backed cross-stack traces", () => {
  it("retrieves a Seolad-style results path with exact references and explicit uncertainty", async () => {
    const graph = await graphFromSources(completeSources, []);
    const traces = discoverSourceTraces(graph, "exam-result processing");
    const resultTrace = traces.find(trace => trace.title.endsWith("getresultinput"));
    expect(resultTrace?.status).toBe("connected");
    expect(resultTrace?.steps.map(item => item.label)).toEqual(expect.arrayContaining([
      expect.stringContaining("UI Router state seo.dashboard.results"),
      expect.stringContaining("Frontend request index.php/gett/getresultinput; method unknown"),
      expect.stringContaining("Inferred parameterized frontend-to-route match"),
      expect.stringContaining("Route declaration resolves to controller entry Getdatactrl.php#getData"),
      expect.stringContaining("Static dispatch to getResultinput"),
      expect.stringContaining("Model-call evidence: complexQuery"),
    ]));
    expect(resultTrace?.steps.find(item => item.label.startsWith("Inferred parameterized"))?.certainty).toBe("inferred");
    expect(resultTrace?.steps.find(item => item.label.startsWith("Static dispatch"))?.certainty).toBe("observed");
    expect(resultTrace?.steps.find(item => item.label.startsWith("Model-call"))?.certainty).toBe("inferred");
    const refs = resultTrace?.steps.flatMap(item => item.sourceRefs) ?? [];
    expect(refs).toEqual(expect.arrayContaining([
      { path: "assets/js/routes.js", startLine: 2, endLine: 2 },
      { path: "assets/js/angular.main.js", startLine: 2, endLine: 2 },
      { path: "assets/js/services.js", startLine: 2, endLine: 4 },
      { path: "application/config/routes.php", startLine: 2, endLine: 2 },
      { path: "application/controllers/Getdatactrl.php", startLine: 7, endLine: 7 },
      { path: "application/controllers/Getdatactrl.php", startLine: 15, endLine: 15 },
    ]));
    expect(refs.every(ref => ref.startLine > 0 && ref.endLine - ref.startLine <= 20)).toBe(true);

    const tool = executeInvestigationTool(graph, "trace_source_flow", { query: "result", componentId: "", depth: 0 });
    expect(tool.items.map(item => item.label)).toEqual(expect.arrayContaining([
      expect.stringContaining("UI Router state"),
      expect.stringContaining("Frontend request and wrapper"),
      expect.stringContaining("Backend route and controller"),
      expect.stringContaining("Dispatch and model calls"),
    ]));
    expect(tool.items.some(item => item.supportingSources?.some(ref => ref.path === "application/controllers/Getdatactrl.php"))).toBe(true);
    expect(parseGraph(JSON.stringify(graph))).toEqual(graph);

    const browser = await scanSelectedDirectory(completeSources.map(item => browserFile(item.path, item.content)));
    expect(discoverSourceTraces(browser.graph, "result")).toEqual(discoverSourceTraces(graph, "result"));
    expect(browser.graph.edges).toEqual(graph.edges);
  });

  it("offers the bounded trace to the existing assistant and validates cited grouped references", async () => {
    const graph = await graphFromSources(completeSources, []);
    const requests: string[] = [];
    let actionNumber = 0;
    const provider: ModelProvider = {
      kind: "MOCK",
      async complete(request) {
        requests.push(request.input);
        if (request.name === "investigation_action_v1") {
          actionNumber++;
          return {
            value: actionNumber === 1
              ? { tool: "trace_source_flow", query: "exam-result processing", componentId: "", depth: 0 }
              : { tool: "finish", query: "", componentId: "", depth: 0 },
            model: "fixture",
            latencyMs: 0,
          };
        }
        const finalInput = JSON.parse(request.input) as { packet: { items: { id: string; label: string }[] } };
        const traceItems = finalInput.packet.items.filter(item => /^(?:UI Router state|Frontend request and wrapper|Backend route and controller|Dispatch and model calls):/.test(item.label));
        expect(traceItems).toHaveLength(4);
        return {
          value: {
            schemaVersion: "1.0.0",
            status: "observed-structure",
            answer: "The observed AngularJS results state and call site use a URL-forwarding upload wrapper with unknown HTTP method. An inferred parameterized route reaches Getdatactrl::getData; static dispatch and inferred model-call evidence do not prove runtime execution.",
            evidenceIds: traceItems.map(item => item.id),
            uncertainty: "The frontend-to-route link is inferred; runtime execution and any database outcome are not established.",
          },
          model: "fixture",
          latencyMs: 0,
        };
      },
    };
    const report = await runAutonomousInvestigation(
      graph,
      "imported-graph",
      "Where is exam-result processing implemented, and how does the frontend request reach the PHP backend?",
      provider,
      new AbortController().signal,
      () => undefined,
    );
    expect(report.answer.status).toBe("observed-structure");
    expect(report.actions.map(item => item.tool)).toEqual(["trace_source_flow"]);
    expect(requests[0]).toContain("trace_source_flow");
    const cited = report.items.filter(item => report.answer.evidenceIds.includes(item.id));
    expect(cited).toHaveLength(4);
    expect(cited.every(item => item.source && item.supportingSources?.length)).toBe(true);
    for (const item of cited) {
      for (const reference of [item.source, ...(item.supportingSources ?? [])]) {
        expect(sourceReference(reference)).toMatch(/^[a-zA-Z0-9_./-]+:\d+(?:-\d+)?$/);
      }
    }
    expect(parseRepositoryAnswer(report.answer, {
      schemaVersion: "1.0.0",
      scope: "repository",
      snapshotId: graph.snapshotId,
      origin: "imported-graph",
      sourceAvailability: "references-only",
      excerpts: [],
      candidates: [],
      indicators: [],
      items: report.items,
      coverage: { candidateGroupsFound: 0, candidateGroupsRepresented: 0, referencesRepresented: report.items.length, analyzedFiles: graph.scan.fileCount, omittedCandidateGroups: 0, truncated: true },
      limitations: ["Static graph metadata does not verify runtime behavior.", "Source bodies and excerpts are unavailable."],
    })).toEqual(report.answer);
  });

  it("labels missing and ambiguous routes without inventing dispatch or methods", async () => {
    const missing: Graph = await graphFromSources([
      source("src/calls.js", `app.controller('resultCtr', function () { postForm.postMultiForm({}, 'index.php/gett/getresultinput'); });`),
      source("assets/js/services.js", wrapper),
    ], []);
    const missingTrace = discoverSourceTraces(missing, "result")[0];
    expect(missingTrace?.status).toBe("unresolved");
    expect(missingTrace?.steps.some(item => item.label.includes("method unknown"))).toBe(true);
    expect(missingTrace?.steps.some(item => item.label.includes("No supported backend route match"))).toBe(true);
    expect(missingTrace?.steps.some(item => item.label.startsWith("Static dispatch"))).toBe(false);
    expect(parseInvestigationToolCall({ tool: "trace_source_flow", query: "result", componentId: "", depth: 0 }, missing).tool).toBe("trace_source_flow");

    const ambiguous = await graphFromSources([
      source("src/calls.js", `fetch('/gett/getresultinput');`),
      source("application/config/routes.php", `<?php
$route['gett/getresultinput'] = 'getdatactrl/getdata';
`),
      source("application/controllers/Getdatactrl.php", phpController),
      source("routes/web.php", `<?php
use App\\Http\\Controllers\\ResultController;
Route::get('/gett/getresultinput', [ResultController::class, 'index']);
`),
      source("app/Http/Controllers/ResultController.php", `<?php
namespace App\\Http\\Controllers;
class ResultController { public function index() {} }
`),
    ], []);
    const ambiguousTrace = discoverSourceTraces(ambiguous, "result")[0];
    expect(ambiguousTrace?.status).toBe("ambiguous");
    expect(ambiguousTrace?.steps.some(item => item.label.includes("ambiguous"))).toBe(true);
    expect(ambiguousTrace?.steps.some(item => item.label.startsWith("Static dispatch"))).toBe(false);
  });
});
