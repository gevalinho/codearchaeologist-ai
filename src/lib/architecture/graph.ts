import type { Edge, GitHubSourceIdentity, Graph, Node, SourceCoverage, SourceRef } from "../archaeology/scanner";

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_VISIBLE_NODES = 36;
export const MAX_VISIBLE_EDGES = 90;
const kinds = new Set(["file", "class", "method", "angular-module", "controller", "service", "factory", "table", "endpoint", "branch", "module", "function", "component", "route", "http-call"]);
const domains = new Set(["school-management", "healthcare-legacy", "shared-infrastructure", "unknown"]);
const certainty = new Set(["observed", "inferred"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function validSourceCoverage(value: unknown): value is SourceCoverage {
  if (!record(value) || Object.keys(value).sort().join() !== "analyzedFiles,eligibleFiles,omittedFiles,partial,selectedFiles,skippedFiles" || ![value.eligibleFiles, value.selectedFiles, value.omittedFiles, value.analyzedFiles, value.skippedFiles].every(count => Number.isSafeInteger(count) && (count as number) >= 0)) return false;
  return value.eligibleFiles === (value.selectedFiles as number) + (value.omittedFiles as number) && (value.analyzedFiles as number) <= (value.selectedFiles as number) && typeof value.partial === "boolean" && value.partial === ((value.omittedFiles as number) > 0 || (value.skippedFiles as number) > 0 || (value.analyzedFiles as number) < (value.selectedFiles as number));
}
export function validGitHubSourceIdentity(value: unknown): value is GitHubSourceIdentity {
  return record(value) && Object.keys(value).sort().join() === "commitSha,name,owner,visibility" && typeof value.owner === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value.owner) && !value.owner.includes("--") && typeof value.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.name) && !value.name.endsWith(".git") && !value.name.endsWith(".") && typeof value.commitSha === "string" && /^[a-f0-9]{40}$/.test(value.commitSha) && (value.visibility === "public" || value.visibility === "private");
}
const string = (value: unknown, max = 500): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export function safePath(value: unknown): value is string {
  return string(value, 500) && !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== "..") && !/[<>]/.test(value);
}
function validSource(value: unknown): value is SourceRef {
  return record(value) && safePath(value.path) && Number.isSafeInteger(value.startLine) && Number.isSafeInteger(value.endLine) && (value.startLine as number) > 0 && (value.endLine as number) >= (value.startLine as number);
}
export function parseGraph(input: string, byteLength = new TextEncoder().encode(input).length): Graph {
  if (byteLength > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the 5 MB limit.");
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error("Invalid JSON artifact."); }
  if (!record(value) || value.schemaVersion !== "1.0.0") throw new Error("Unsupported graph schema version. Expected 1.0.0.");
  if (!string(value.snapshotId, 128) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 20000 || value.edges.length > 50000) throw new Error("Invalid graph structure or count.");
  if (!Array.isArray(value.warnings) || !value.warnings.every(x => typeof x === "string") || !Array.isArray(value.limitations) || !value.limitations.every(x => typeof x === "string")) throw new Error("Invalid graph metadata.");
  if (!record(value.scan) || !Number.isSafeInteger(value.scan.fileCount) || !Number.isSafeInteger(value.scan.totalBytes) || (value.scan.fileCount as number) < 0 || (value.scan.totalBytes as number) < 0) throw new Error("Invalid scan metadata.");
  if (value.sourceCoverage !== undefined && (!validSourceCoverage(value.sourceCoverage) || value.sourceCoverage.analyzedFiles !== value.scan.fileCount)) throw new Error("Invalid source coverage metadata.");
  if (value.githubSource !== undefined && !validGitHubSourceIdentity(value.githubSource)) throw new Error("Invalid GitHub source identity.");
  if (value.analysisCapabilities !== undefined && !validAnalysisCapabilities(value.analysisCapabilities, value.nodes as unknown[])) throw new Error("Invalid analysis capability metadata.");
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!record(node) || !string(node.id) || !string(node.name) || !kinds.has(node.kind as string) || !domains.has(node.domain as string) || !certainty.has(node.certainty as string) || !string(node.method) || !validSource(node.source)) throw new Error("Invalid node structure or source reference.");
    if (nodeIds.has(node.id)) throw new Error("Duplicate node ID.");
    nodeIds.add(node.id);
  }
  function validAnalysisCapabilities(value: unknown, graphNodes: unknown[]): boolean {
    if (!record(value) || Object.keys(value).some(key => !["javascriptTypescript", "php", "phpRouting", "backendRouting", "crossStack"].includes(key))) return false;
    const adapters = (items: unknown) => Array.isArray(items) && items.length <= 20 && items.every(item => record(item) && Object.keys(item).sort().join() === "adapter,dynamicRoutes,staticRoutes,status" && string(item.adapter, 80) && ["analyzed", "partial", "unsupported", "not-detected"].includes(item.status as string) && Number.isSafeInteger(item.staticRoutes) && (item.staticRoutes as number) >= 0 && Number.isSafeInteger(item.dynamicRoutes) && (item.dynamicRoutes as number) >= 0);
    if (value.javascriptTypescript !== undefined) {
      const js = value.javascriptTypescript;
      if (!record(js) || !["analyzedFiles,parser,routingAdapters,unsupportedFiles", "analyzedFiles,parser,routingAdapters,uiRouterStates,unsupportedFiles"].includes(Object.keys(js).sort().join()) || js.parser !== "babel" || !Number.isSafeInteger(js.analyzedFiles) || (js.analyzedFiles as number) < 0 || !Number.isSafeInteger(js.unsupportedFiles) || (js.unsupportedFiles as number) < 0 || !adapters(js.routingAdapters)) return false;
      if (js.uiRouterStates !== undefined && (!Array.isArray(js.uiRouterStates) || js.uiRouterStates.length > 1000 ||
          !js.uiRouterStates.every(state => {
            if (!record(state) || !string(state.state, 200) || !validSource(state.source) ||
                state.url !== undefined && !string(state.url, 500) ||
                state.templateUrl !== undefined && !string(state.templateUrl, 500) ||
                state.controller !== undefined && !string(state.controller, 200) ||
                state.stateNameSource !== undefined && !validSource(state.stateNameSource) ||
                state.templateSource !== undefined && !validSource(state.templateSource) ||
                state.controllerSource !== undefined && !validSource(state.controllerSource)) return false;
            const keys = Object.keys(state).filter(key => key !== "stateNameSource").sort().join();
            const allowed = new Set([
              "source,state",
              "source,state,url",
              "controller,controllerSource,source,state",
              "controller,controllerSource,source,state,url",
              "source,state,templateSource,templateUrl",
              "source,state,templateSource,templateUrl,url",
              "controller,controllerSource,source,state,templateSource,templateUrl",
              "controller,controllerSource,source,state,templateSource,templateUrl,url",
            ]);
            return allowed.has(keys) && (state.templateSource === undefined || state.templateUrl !== undefined) &&
              (state.controllerSource === undefined || state.controller !== undefined);
          }))) return false;
    }
    if (value.php !== undefined) {
      const php = value.php;
      if (!record(php) || Object.keys(php).sort().join() !== "analyzedFiles,indexedSymbols,parser,partialFiles,unsupportedFiles" || php.parser !== "php-parser" || ![php.analyzedFiles, php.indexedSymbols, php.partialFiles, php.unsupportedFiles].every(count => Number.isSafeInteger(count) && (count as number) >= 0)) return false;
    }
    if (value.phpRouting !== undefined) {
      const phpRouting = value.phpRouting;
      if (!record(phpRouting) || Object.keys(phpRouting).sort().join() !== "adapters,routes" || !Array.isArray(phpRouting.adapters) || phpRouting.adapters.length !== 3 || !Array.isArray(phpRouting.routes) || phpRouting.routes.length > 2000) return false;
      const supportedAdapters = new Set(["codeigniter-3", "codeigniter-4", "laravel"]);
      if (!phpRouting.adapters.every(item => record(item) &&
        Object.keys(item).sort().join() === "adapter,ambiguousRoutes,detection,dynamicRoutes,staticRoutes,status,unresolvedRoutes" &&
        supportedAdapters.has(item.adapter as string) &&
        ["confirmed", "probable", "unknown"].includes(item.detection as string) &&
        ["analyzed", "partial", "unsupported", "not-detected"].includes(item.status as string) &&
        [item.staticRoutes, item.dynamicRoutes, item.ambiguousRoutes, item.unresolvedRoutes].every(count => Number.isSafeInteger(count) && (count as number) >= 0))) return false;
      if (!phpRouting.routes.every(route => {
        if (!record(route) || !["codeigniter-3", "codeigniter-4", "laravel"].includes(route.adapter as string) ||
          !Array.isArray(route.methods) || route.methods.length > 5 || !route.methods.every(method => string(method, 16)) ||
          !Array.isArray(route.middleware) || route.middleware.length > 20 || !route.middleware.every(item => string(item, 100)) ||
          route.parameterBindings !== undefined && (!Array.isArray(route.parameterBindings) || route.parameterBindings.length > 10 ||
            !route.parameterBindings.every(binding => record(binding) &&
              Object.keys(binding).sort().join() === "argument,routeParameter" &&
              Number.isSafeInteger(binding.argument) && (binding.argument as number) > 0 && (binding.argument as number) <= 10 &&
              Number.isSafeInteger(binding.routeParameter) && (binding.routeParameter as number) > 0 && (binding.routeParameter as number) <= 10)) ||
          !validSource(route.source) || !["observed", "inferred"].includes(route.certainty as string) ||
          !["resolved", "unresolved", "ambiguous", "dynamic"].includes(route.resolution as string)) return false;
        const keys = Object.keys(route).filter(key => key !== "parameterBindings").sort().join();
        const allowed = new Set([
          "adapter,certainty,methods,middleware,resolution,source",
          "adapter,certainty,methods,middleware,path,resolution,source",
          "adapter,certainty,methods,middleware,resolution,source,target",
          "adapter,certainty,methods,middleware,path,resolution,source,target",
          "adapter,certainty,methods,middleware,resolution,resolvedMethod,source,target",
          "adapter,certainty,methods,middleware,path,resolution,resolvedMethod,source,target",
        ]);
        return allowed.has(keys) && (route.path === undefined || string(route.path, 500)) &&
          (route.target === undefined || string(route.target, 300)) &&
          (route.resolvedMethod === undefined || string(route.resolvedMethod, 500));
      })) return false;
    }
    if (value.crossStack !== undefined) {
      const crossStack = value.crossStack;
      if (!record(crossStack) || Object.keys(crossStack).sort().join() !== "matches,omittedHttpCalls,phpMethodCalls,totalHttpCalls" ||
          !Number.isSafeInteger(crossStack.totalHttpCalls) || (crossStack.totalHttpCalls as number) < 0 ||
          !Number.isSafeInteger(crossStack.omittedHttpCalls) || (crossStack.omittedHttpCalls as number) < 0 ||
          !Array.isArray(crossStack.matches) || crossStack.matches.length > 2000 ||
          (crossStack.totalHttpCalls as number) !== crossStack.matches.length + (crossStack.omittedHttpCalls as number)) return false;
      const sourceEqual = (left: unknown, right: unknown) => record(left) && record(right) &&
        left.path === right.path && left.startLine === right.startLine && left.endLine === right.endLine;
      for (const match of crossStack.matches) {
        if (!record(match)) return false;
        const frontendSource = match.frontendSource;
        if (!string(match.endpointId) ||
            !validSource(frontendSource) || !Array.isArray(match.routeIds) || match.routeIds.length > 20 ||
            !Array.isArray(match.backendSources) || match.backendSources.length !== match.routeIds.length ||
            !Number.isSafeInteger(match.totalCandidateCount) || (match.totalCandidateCount as number) < match.routeIds.length ||
            typeof match.candidatesTruncated !== "boolean" ||
            match.candidatesTruncated !== ((match.totalCandidateCount as number) > match.routeIds.length) ||
            typeof match.controllerActionResolved !== "boolean" ||
            !["exact", "parameterized", "ambiguous", "unresolved"].includes(match.status as string)) return false;
        const endpoint = graphNodes.find(node => record(node) && node.id === match.endpointId);
        if (!record(endpoint) || !["endpoint", "http-call"].includes(endpoint.kind as string) ||
            !graphNodes.some(node => record(node) && node.kind === "file" && node.name === frontendSource.path)) return false;
        const routeIds = match.routeIds as unknown[];
        const backendSources = match.backendSources as unknown[];
        for (let index = 0; index < routeIds.length; index++) {
          const route = graphNodes.find(node => record(node) && node.id === routeIds[index]);
          if (!record(route) || route.kind !== "route" || !validSource(backendSources[index]) || !sourceEqual(route.source, backendSources[index])) return false;
        }
        const keys = Object.keys(match).sort().join();
        const allowed = new Set([
          "backendSources,candidatesTruncated,controllerActionResolved,endpointId,frontendSource,routeIds,status,totalCandidateCount",
          "backendSources,candidatesTruncated,controllerActionResolved,endpointId,frontendSource,routeIds,status,totalCandidateCount,wrapperSource",
          "backendSources,candidatesTruncated,controllerActionResolved,endpointId,frontendSource,method,routeIds,status,totalCandidateCount",
          "backendSources,candidatesTruncated,controllerActionResolved,endpointId,frontendSource,method,routeIds,status,totalCandidateCount,wrapperSource",
          "backendSources,candidatesTruncated,controllerActionResolved,endpointId,frontendSource,reason,routeIds,status,totalCandidateCount",
          "backendSources,candidatesTruncated,controllerActionResolved,endpointId,frontendSource,reason,routeIds,status,totalCandidateCount,wrapperSource",
          "backendSources,candidatesTruncated,controllerActionResolved,endpointId,frontendSource,method,reason,routeIds,status,totalCandidateCount",
          "backendSources,candidatesTruncated,controllerActionResolved,endpointId,frontendSource,method,reason,routeIds,status,totalCandidateCount,wrapperSource",
        ]);
        if (!allowed.has(keys) || (match.wrapperSource !== undefined && !validSource(match.wrapperSource)) ||
            (match.method !== undefined && !string(match.method, 16)) ||
            (match.reason !== undefined && !["dynamic-frontend-path", "method-mismatch", "no-route-match", "unsupported-backend-pattern", "multiple-routes"].includes(match.reason as string))) return false;
        if ((match.status === "exact" || match.status === "parameterized") &&
            (match.routeIds.length !== 1 || match.reason !== undefined)) return false;
        if (match.status === "ambiguous" && (match.reason !== "multiple-routes" || match.totalCandidateCount as number < 2)) return false;
        if (match.status === "unresolved" && match.reason === undefined) return false;
      }
      const calls = crossStack.phpMethodCalls;
      if (!record(calls) || Object.keys(calls).sort().join() !== "observed,unresolved,unsupported" ||
          !Number.isSafeInteger(calls.observed) || (calls.observed as number) < 0 ||
          !Number.isSafeInteger(calls.unresolved) || (calls.unresolved as number) < 0 ||
          !Array.isArray(calls.unsupported) || calls.unsupported.length > 20 || !calls.unsupported.every(item => string(item, 200))) return false;
    }
    return value.backendRouting === undefined || adapters(value.backendRouting);
  }
  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (!record(edge) || !string(edge.id) || !string(edge.from) || !string(edge.to) || !string(edge.kind) || !certainty.has(edge.certainty as string) || !string(edge.method) || !validSource(edge.source)) throw new Error("Invalid edge structure or source reference.");
    if (edgeIds.has(edge.id)) throw new Error("Duplicate edge ID.");
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error("Edge references a missing node.");
    edgeIds.add(edge.id);
  }
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules) || value.rules.length > 1000) throw new Error("Invalid business-rule evidence count.");
    const ruleIds = new Set<string>();
    for (const rule of value.rules) {
      if (!record(rule) || !string(rule.id) || ruleIds.has(rule.id) || !["condition", "validation", "authorization", "state-transition", "calculation"].includes(rule.kind as string) || !string(rule.description) || !string(rule.ownerNodeId) || !nodeIds.has(rule.ownerNodeId) || !validSource(rule.source) || rule.certainty !== "observed" || rule.method !== "deterministic-rule-pattern-v1") throw new Error("Invalid business-rule evidence.");
      ruleIds.add(rule.id);
    }
  }
  return value as Graph;
}
export const sourceReference = (source: SourceRef) => `${source.path}:${source.startLine}${source.endLine === source.startLine ? "" : `-${source.endLine}`}`;
export type Filters = { query: string; domains: Set<string>; kinds: Set<string>; certainties: Set<string> };
export function filterNodes(nodes: Node[], filters: Filters): Node[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return nodes.filter(node => (!query || `${node.name} ${node.source.path} ${node.kind}`.toLocaleLowerCase().includes(query)) && (!filters.domains.size || filters.domains.has(node.domain)) && (!filters.kinds.size || filters.kinds.has(node.kind)) && (!filters.certainties.size || filters.certainties.has(node.certainty)));
}
export function indexGraph(graph: Graph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map<string, Edge[]>(), outgoing = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  return { nodes, incoming, outgoing };
}
export function neighborhood(graph: Graph, seeds: string[], depth = 1, direction: "both" | "incoming" | "outgoing" = "both", allowedNodeIds?: ReadonlySet<string>) {
  const index = indexGraph(graph), seen = new Set(seeds.filter(id => index.nodes.has(id))), queue = [...seen].map(id => ({ id, distance: 0 }));
  for (let i = 0; i < queue.length && seen.size < MAX_VISIBLE_NODES; i++) {
    const current = queue[i];
    if (current.distance >= depth) continue;
    const edges = [...(direction === "outgoing" ? [] : index.incoming.get(current.id) ?? []), ...(direction === "incoming" ? [] : index.outgoing.get(current.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    for (const edge of edges) {
      const next = edge.from === current.id ? edge.to : edge.from;
      if (allowedNodeIds && !allowedNodeIds.has(next)) continue;
      if (!seen.has(next) && seen.size < MAX_VISIBLE_NODES) { seen.add(next); queue.push({ id: next, distance: current.distance + 1 }); }
    }
  }
  const nodes = [...seen].map(id => index.nodes.get(id)!).sort((a, b) => a.id.localeCompare(b.id));
  const edges = graph.edges.filter(edge => seen.has(edge.from) && seen.has(edge.to)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_VISIBLE_EDGES);
  return { nodes, edges, truncated: nodes.length < graph.nodes.length || edges.length < graph.edges.length };
}
export function layout(nodes: Node[]) {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  return new Map(ordered.map((node, i) => [node.id, { x: 150 + (i % 4) * 230, y: 100 + Math.floor(i / 4) * 135 }]));
}
const promotionTerms = ["promotionCtr", "getPromotion", "putPromotion", "putScore", "getCollatedResultinput", "index.php/reg/putpromotion", "index.php/gett/getpromotiondata"];
export function promotionInvestigation(graph: Graph) {
  const matches = promotionTerms.map(term => ({ term, node: graph.nodes.find(node => node.name.toLowerCase().includes(term.toLowerCase())) })).filter(item => item.node !== undefined);
  return { matches, missing: promotionTerms.filter(term => !matches.some(item => item.term === term)), view: neighborhood(graph, matches.map(item => item.node!.id), 1) };
}
