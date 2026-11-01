import type { AngularUiRouterState, Edge, Graph, SourceRef } from "../archaeology/scanner";
import type { PacketItem } from "./ai-evidence";
import { safeAiLabel, safeAiSourceRef } from "./ai-evidence";

export type SourceTraceCertainty = "observed" | "inferred" | "ambiguous" | "unresolved";
export type SourceTraceStep = {
  label: string;
  certainty: SourceTraceCertainty;
  sourceRefs: SourceRef[];
};
export type SourceTrace = {
  id: string;
  title: string;
  status: "connected" | "ambiguous" | "unresolved";
  steps: SourceTraceStep[];
};

const lineRef = (source: SourceRef): SourceRef => ({
  path: source.path,
  startLine: source.startLine,
  endLine: source.startLine,
});
const sourceKey = (source: SourceRef) => `${source.path}:${source.startLine}`;
const uniqueSources = (sources: SourceRef[], limit = 12): SourceRef[] => [
  ...new Map(sources.map(source => source.endLine - source.startLine <= 20 ? source : lineRef(source)).filter(safeAiSourceRef).map(ref => {
    return [sourceKey(ref), ref] as const;
  })).values(),
].slice(0, limit);
const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const methodName = (name: string) => name.split("#").at(-1) ?? name;
const step = (label: string, certainty: SourceTraceCertainty, sources: SourceRef[]): SourceTraceStep => ({
  label: label.slice(0, 160),
  certainty,
  sourceRefs: uniqueSources(sources),
});

export function discoverSourceTraces(graph: Graph, query = ""): SourceTrace[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const matches = graph.analysisCapabilities?.crossStack?.matches ?? [];
  const grouped = new Map<string, typeof matches>();
  for (const match of matches) {
    const indexed = grouped.get(match.endpointId);
    if (indexed) indexed.push(match);
    else grouped.set(match.endpointId, [match]);
  }
  for (const endpoint of graph.nodes.filter(node => node.kind === "endpoint" || node.kind === "http-call")) {
    if (!grouped.has(endpoint.id)) grouped.set(endpoint.id, []);
  }
  const callsByEndpoint = new Map<string, Edge[]>();
  const routesByRoute = new Map<string, Edge[]>();
  const dispatchByController = new Map<string, Edge[]>();
  const modelsByMethod = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const index = edge.kind === "calls-endpoint" ? callsByEndpoint
      : edge.kind === "routes-to" ? routesByRoute
        : edge.kind === "dispatches-to" ? dispatchByController
          : edge.kind === "calls-model-method" ? modelsByMethod : undefined;
    if (index) {
      const key = edge.kind === "calls-endpoint" ? edge.to : edge.from;
      const indexed = index.get(key);
      if (indexed) indexed.push(edge);
      else index.set(key, [edge]);
    }
  }
  const statesByController = new Map<string, AngularUiRouterState[]>();
  for (const state of graph.analysisCapabilities?.javascriptTypescript?.uiRouterStates ?? []) {
    if (!state.controller) continue;
    const indexed = statesByController.get(state.controller);
    if (indexed) indexed.push(state);
    else statesByController.set(state.controller, [state]);
  }
  const search = query.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const titleMatchedIds = new Set([...grouped.keys()].filter(id => {
    const title = nodes.get(id)?.name.toLowerCase() ?? "";
    return search.some(term => title.includes(term));
  }));
  const useTitleMatches = titleMatchedIds.size > 0;
  const candidates = [...grouped.keys()]
    .map(id => ({ id, title: nodes.get(id)?.name ?? "" }))
    .filter(item => !search.length || !useTitleMatches || titleMatchedIds.has(item.id))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const traces: SourceTrace[] = [];

  for (const { id: endpointId } of candidates) {
    const endpointMatches = grouped.get(endpointId)!;
    const endpoint = nodes.get(endpointId);
    if (!endpoint) continue;
    const routeIds = [...new Set(endpointMatches.flatMap(match => match.routeIds))].slice(0, 20);
    const routeNodes = routeIds.map(id => nodes.get(id)).filter((node): node is NonNullable<typeof node> => !!node);
    const routeEdges = routeIds.flatMap(id => routesByRoute.get(id) ?? []).slice(0, 20);
    const controllerIds = [...new Set(routeEdges.map(edge => edge.to))];
    const controllerNodes = controllerIds.map(id => nodes.get(id)).filter((node): node is NonNullable<typeof node> => !!node);
    const requestRefs = uniqueSources(endpointMatches.length ? endpointMatches.map(match => match.frontendSource) : [endpoint.source], 12);
    const wrapperRefs = uniqueSources(endpointMatches.flatMap(match => match.wrapperSource ? [match.wrapperSource] : []), 4);
    const endpointOwners = (callsByEndpoint.get(endpointId) ?? [])
      .map(edge => nodes.get(edge.from))
      .filter((node): node is NonNullable<typeof node> => !!node);
    const matchingStates = [...new Map(endpointOwners.flatMap(owner => {
      const ownerName = owner.name.split("#").at(-1) ?? "";
      return (statesByController.get(ownerName) ?? []).map(state => [`${state.state}:${state.source.path}:${state.source.startLine}`, state] as const);
    })).values()].slice(0, 3);

    const steps: SourceTraceStep[] = [];
    if (matchingStates.length) {
      for (const state of matchingStates.slice(0, 3)) {
        const detail = [
          `UI Router state ${state.state}`,
          state.url ? `URL ${state.url}` : "",
          state.templateUrl ? `template ${state.templateUrl}` : "",
          state.controller ? `controller ${state.controller}` : "",
        ].filter(Boolean).join("; ");
        steps.push(step(detail, "observed", [
          ...(state.stateNameSource ? [state.stateNameSource] : state.source.endLine - state.source.startLine <= 20 ? [state.source] : []),
          ...(state.templateSource ? [state.templateSource] : []),
          ...(state.controllerSource ? [state.controllerSource] : []),
        ]));
      }
    }

    const methods = [...new Set(endpointMatches.map(match => match.method).filter((method): method is string => !!method))];
    const methodLabel = methods.length === 0 ? "unknown" : methods.length === endpointMatches.length ? methods.join("/") : `${methods.join("/")} where known; otherwise unknown`;
    const requestLabel = `Frontend request ${endpoint.name}; method ${methodLabel}` +
      (wrapperRefs.length ? "; custom upload wrapper forwards its URL argument" : "");
    steps.push(step(requestLabel, "observed", [...requestRefs, ...wrapperRefs]));

    const matchStatus = routeIds.length > 1 || endpointMatches.some(match => match.status === "ambiguous") ||
      endpointMatches.some(match => match.status === "unresolved") && endpointMatches.some(match => match.status === "exact" || match.status === "parameterized")
      ? "ambiguous"
      : endpointMatches.every(match => match.status === "unresolved") ? "unresolved" : "inferred";
    if (routeNodes.length) {
      for (const route of routeNodes.slice(0, 4)) {
        const routeRefs = endpointMatches.flatMap(match => {
          const index = match.routeIds.indexOf(route.id);
          return index >= 0 ? [match.backendSources[index]] : [];
        });
        const pathMatch = endpointMatches.find(match => match.routeIds.includes(route.id))?.status ?? "unresolved";
        steps.push(step(`Inferred ${pathMatch} frontend-to-route match: ${route.name.split("#").at(-1) ?? route.name}`, matchStatus, routeRefs));
      }
    } else {
      steps.push(step(
        endpointMatches.some(match => match.status === "ambiguous") ? "Backend route match is ambiguous." : "No supported backend route match was recorded.",
        endpointMatches.some(match => match.status === "ambiguous") ? "ambiguous" : "unresolved",
        requestRefs,
      ));
    }

    for (const edge of routeEdges.slice(0, 4)) {
      const target = nodes.get(edge.to);
      steps.push(step(
        target ? `Route declaration resolves to controller entry ${target.name.split(/[\\/]/).at(-1) ?? target.name}` : "Route target node is unavailable.",
        target ? edge.certainty : "unresolved",
        [edge.source, ...(target ? [target.source] : [])],
      ));
    }

    const operation = normalized(endpoint.name.split(/[/?#]/).filter(Boolean).at(-1) ?? "");
    const dispatchEdges = matchStatus === "inferred" && controllerIds.length === 1 ? (dispatchByController.get(controllerIds[0]) ?? []).filter(edge =>
      edge.from === controllerIds[0] &&
      normalized(methodName(nodes.get(edge.to)?.name ?? "")) === operation) : [];
    for (const edge of dispatchEdges.slice(0, 4)) {
      const target = nodes.get(edge.to);
      steps.push(step(
        target ? `Static dispatch to ${methodName(target.name)}; this does not prove runtime execution.` : "Dispatch target is unavailable.",
        target ? edge.certainty : "unresolved",
        [edge.source, ...(target ? [target.source] : [])],
      ));
      if (!target) continue;
      const modelEdges = (modelsByMethod.get(target.id) ?? []).slice(0, 2);
      for (const modelEdge of modelEdges) {
        const model = nodes.get(modelEdge.to);
        steps.push(step(
          model ? `Model-call evidence: ${methodName(model.name)}; inferred call, not proof of a database outcome.` : "Model-call target is unresolved.",
          model ? modelEdge.certainty : "unresolved",
          [modelEdge.source, ...(model ? [model.source] : [])],
        ));
      }
      if (!modelEdges.length) steps.push(step("No supported model-call relationship was recorded for this handler.", "unresolved", [target.source]));
    }
    if (controllerIds.length && !dispatchEdges.length) {
      steps.push(step(matchStatus === "ambiguous" || controllerIds.length > 1
        ? "Route/controller correlation is ambiguous; no unique static dispatch target is asserted."
        : "No matching static dispatch evidence was recorded for this route parameter.", matchStatus === "ambiguous" || controllerIds.length > 1 ? "ambiguous" : "unresolved", [
        ...controllerNodes.map(controller => controller.source),
        ...routeNodes.map(route => route.source),
      ]));
    }

    if (!routeEdges.length && routeNodes.length) {
      steps.push(step("Route declaration does not resolve to a unique controller entry point.", "unresolved", routeNodes.map(route => route.source)));
    }
    const title = endpoint.name.slice(0, 160);
    const trace: SourceTrace = {
      id: endpointId,
      title,
      status: matchStatus === "ambiguous" ? "ambiguous" : endpointMatches.length > 0 && endpointMatches.every(match => match.status === "exact" || match.status === "parameterized") ? "connected" : "unresolved",
      steps: steps.filter(item => item.sourceRefs.length > 0),
    };
    const searchable = `${trace.title} ${trace.steps.map(item => item.label).join(" ")}`.toLowerCase();
    if (!search.length || titleMatchedIds.has(endpointId) || !useTitleMatches && search.some(term => searchable.includes(term))) {
      traces.push(trace);
      if (traces.length >= 12) break;
    }
  }
  return traces;
}

export function sourceTraceEvidence(graph: Graph, query: string): Omit<PacketItem, "id">[] {
  const traces = discoverSourceTraces(graph, query);
  if (!traces.length) return [];
  const phases = [
    { key: "UI Router state", select: (item: SourceTraceStep) => item.label.startsWith("UI Router state") },
    { key: "Frontend request and wrapper", select: (item: SourceTraceStep) => item.label.startsWith("Frontend request") },
    { key: "Backend route and controller", select: (item: SourceTraceStep) => item.label.includes("frontend-to-route match") || item.label.startsWith("Route declaration") || item.label.startsWith("Backend route") || item.label.startsWith("No supported backend route") },
    { key: "Dispatch and model calls", select: (item: SourceTraceStep) => item.label.startsWith("Static dispatch") || item.label.startsWith("Model-call") || item.label.startsWith("No supported model-call") || item.label.startsWith("No matching static dispatch") },
  ];
  const result: Omit<PacketItem, "id">[] = [];
  for (const phase of phases) {
    const relevant = traces.flatMap(trace => trace.steps.filter(phase.select));
    if (!relevant.length) continue;
    const sources = uniqueSources(relevant.flatMap(item => item.sourceRefs));
    const certainty: PacketItem["certainty"] =
      relevant.some(item => item.certainty === "unresolved" || item.certainty === "ambiguous" || item.certainty === "inferred") ? "inferred" : "observed";
    const labels = relevant.map(item => item.label).slice(0, 3);
    const label = `${phase.key}: ${labels.join(" · ")}`.slice(0, 160);
    if (!sources.length || !safeAiLabel(label)) continue;
    result.push({
      kind: "relationship",
      label,
      certainty,
      source: sources[0],
      ...(sources.length > 1 ? { supportingSources: sources.slice(1, 12) } : {}),
    });
  }
  return result.slice(0, 4);
}
