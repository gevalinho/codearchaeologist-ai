import type { Edge, PhpRouteCapability, SourceRef } from "./scanner";
import type { JavaScriptAnalysis } from "./javascript-analysis";
import type { PhpParsedFile, PhpSymbol } from "./php/parser";

type Ast = Record<string, unknown> & { kind: string };
type AddEdge = (from: string, to: string, kind: string, ref: SourceRef, certainty?: Edge["certainty"], method?: string) => void;
type RouteEvidence = PhpRouteCapability & { id: string };

const MAX_CORRELATIONS = 1000;
const MAX_CANDIDATES = 10;
const MAX_PHP_CALL_NODES = 100_000;
const unsupportedPhpCalls = [
  "Dynamic receivers and service-locator lookups are not resolved.",
  "Constructor-injected parameters and inherited method calls are not resolved.",
  "Typed PHP call indexing is bounded to 100,000 AST visits per graph.",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAst(value: unknown): value is Ast {
  return isRecord(value) && typeof value.kind === "string";
}

function nameOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isAst(value) && typeof value.name === "string" ? value.name : undefined;
}

function sourceOf(file: string, node: Ast): SourceRef {
  const loc = isRecord(node.loc) ? node.loc : {};
  const start = isRecord(loc.start) ? loc.start : {};
  const end = isRecord(loc.end) ? loc.end : {};
  const startLine = Number.isSafeInteger(start.line) && (start.line as number) > 0 ? start.line as number : 1;
  const endLine = Number.isSafeInteger(end.line) && (end.line as number) >= startLine ? end.line as number : startLine;
  return { path: file, startLine, endLine };
}

function normalizeConcretePath(value: string): string | undefined {
  const path = value.split(/[?#]/, 1)[0].replace(/^\/?index\.php\//i, "").replace(/^\/+|\/+$/g, "");
  if (/[${}]|:[A-Za-z_]/.test(path)) return undefined;
  return path;
}

function pathSegments(path: string): string[] {
  return path ? path.split("/") : [];
}

type PathMatch = "exact" | "parameterized" | "unsupported" | undefined;

function matchRoutePath(frontend: string, route: RouteEvidence): PathMatch {
  if (!route.path) return undefined;
  const request = normalizeConcretePath(frontend);
  if (request === undefined) return "unsupported";
  const routePath = route.path.replace(/^\/+|\/+$/g, "");
  const routeSegments = pathSegments(routePath);
  const requestSegments = pathSegments(request);
  let parameterized = false;
  let requestIndex = 0;
  const adapter = route.adapter;
  let unsupportedIndex = -1;
  for (let index = 0; index < routeSegments.length; index++) {
    const segment = routeSegments[index];
    const ciToken = adapter !== "laravel" && /^\(:[a-z]+\)$/i.test(segment);
    const laravelToken = adapter === "laravel" && /^\{[A-Za-z_][A-Za-z0-9_]*\??\}$/.test(segment);
    const ciKind = ciToken ? segment.slice(2, -1).toLowerCase() : undefined;
    if ((/[():{}*?<>\[\]^$|+]/.test(segment) && !ciToken && !laravelToken) ||
        (ciToken && (!["num", "alpha", "alphanum", "any", "segment", "all"].includes(ciKind!) ||
          (ciKind === "all" && index !== routeSegments.length - 1))) ||
        (laravelToken && segment.endsWith("?}") && index !== routeSegments.length - 1)) {
      unsupportedIndex = index;
      break;
    }
  }
  if (unsupportedIndex >= 0) {
    return routeSegments.slice(0, unsupportedIndex).every((segment, index) => requestSegments[index] === segment) &&
      requestSegments.length > unsupportedIndex ? "unsupported" : undefined;
  }
  for (let routeIndex = 0; routeIndex < routeSegments.length; routeIndex++) {
    const segment = routeSegments[routeIndex];
    const ci = adapter === "codeigniter-3" || adapter === "codeigniter-4"
      ? /^\(:([a-z]+)\)$/i.exec(segment)
      : undefined;
    const laravel = adapter === "laravel" ? /^\{([A-Za-z_][A-Za-z0-9_]*)(\?)?\}$/.exec(segment) : undefined;
    if (ci) {
      const kind = ci[1].toLowerCase();
      if (!["num", "alpha", "alphanum", "any", "segment", "all"].includes(kind)) return "unsupported";
      parameterized = true;
      if (kind === "all") {
        if (routeIndex !== routeSegments.length - 1 || requestIndex >= requestSegments.length) return undefined;
        requestIndex = requestSegments.length;
        continue;
      }
      const value = requestSegments[requestIndex];
      if (value === undefined) return undefined;
      if (kind === "num" && !/^\d+$/.test(value)) return undefined;
      if (kind === "alpha" && !/^[A-Za-z]+$/.test(value)) return undefined;
      if (kind === "alphanum" && !/^[A-Za-z0-9]+$/.test(value)) return undefined;
      requestIndex++;
      continue;
    }
    if (laravel) {
      parameterized = true;
      if (requestSegments[requestIndex] === undefined && laravel[2]) continue;
      if (requestSegments[requestIndex] === undefined) return undefined;
      requestIndex++;
      continue;
    }
    if (/[():{}*?<>\[\]^$|+]/.test(segment)) return "unsupported";
    if (requestSegments[requestIndex] !== segment) return undefined;
    requestIndex++;
  }
  if (requestIndex !== requestSegments.length) return undefined;
  return parameterized ? "parameterized" : "exact";
}

function methodsCompatible(frontend: string | undefined, backend: string[]): boolean {
  return !frontend || backend.includes("ANY") || backend.includes(frontend);
}

export function correlateFrontendPhpCalls(
  analyses: readonly JavaScriptAnalysis[],
  routes: readonly RouteEvidence[],
  phpFiles: readonly PhpParsedFile[],
  phpSymbols: readonly PhpSymbol[],
  hasNode: (id: string) => boolean,
  addEdge: AddEdge,
): {
  totalHttpCalls: number;
  omittedHttpCalls: number;
  matches: {
    endpointId: string;
    frontendSource: SourceRef;
    wrapperSource?: SourceRef;
    routeIds: string[];
    backendSources: SourceRef[];
    status: "exact" | "parameterized" | "ambiguous" | "unresolved";
    reason?: "dynamic-frontend-path" | "method-mismatch" | "no-route-match" | "unsupported-backend-pattern" | "multiple-routes";
    method?: string;
    controllerActionResolved: boolean;
    totalCandidateCount: number;
    candidatesTruncated: boolean;
  }[];
  dispatchDiagnostics: string[];
} {
  const endpoints = analyses.flatMap(analysis => analysis.endpoints).sort((a, b) =>
    a.ref.path.localeCompare(b.ref.path) || a.ref.startLine - b.ref.startLine || a.ref.endLine - b.ref.endLine || a.id.localeCompare(b.id));
  const matches = [];
  const dispatchDiagnostics: string[] = [];
  for (const endpoint of endpoints.slice(0, MAX_CORRELATIONS)) {
    const uniqueRoutes = [...new Map(routes.map(route => [route.id, route])).values()];
    const routeCandidates = uniqueRoutes.flatMap(route => {
      if (!endpoint.path) return [];
      const match = matchRoutePath(endpoint.path, route);
      return match ? [{ route, match }] : [];
    });
    const make = (
      status: "exact" | "parameterized" | "ambiguous" | "unresolved",
      reason?: "dynamic-frontend-path" | "method-mismatch" | "no-route-match" | "unsupported-backend-pattern" | "multiple-routes",
      candidates: typeof routeCandidates = [],
    ) => ({
      endpointId: endpoint.id,
      frontendSource: endpoint.ref,
      ...(endpoint.wrapperSource ? { wrapperSource: endpoint.wrapperSource } : {}),
      routeIds: candidates.slice(0, MAX_CANDIDATES).map(item => item.route.id),
      backendSources: candidates.slice(0, MAX_CANDIDATES).map(item => item.route.source),
      status,
      ...(reason ? { reason } : {}),
      ...(endpoint.method ? { method: endpoint.method } : {}),
      controllerActionResolved: candidates.some(item => item.route.resolution === "resolved"),
      totalCandidateCount: candidates.length,
      candidatesTruncated: candidates.length > MAX_CANDIDATES,
    });
    const normalized = endpoint.path ? normalizeConcretePath(endpoint.path) : undefined;
    if (!endpoint.path || normalized === undefined) {
      matches.push(make("unresolved", "dynamic-frontend-path"));
      continue;
    }
    const pathMatches = routeCandidates.filter(item => item.match === "exact" || item.match === "parameterized");
    const methodMatches = pathMatches.filter(item => item.route.methods.length > 0 && methodsCompatible(endpoint.method, item.route.methods));
    const unsupportedMatches = routeCandidates.filter(item => item.match === "unsupported");
    if (methodMatches.length === 0 && pathMatches.length > 0) {
      matches.push(make("unresolved", pathMatches.some(item => item.route.methods.length > 0) ? "method-mismatch" : "unsupported-backend-pattern", pathMatches));
      continue;
    }
    if (methodMatches.length === 0) {
      matches.push(make("unresolved", unsupportedMatches.length ? "unsupported-backend-pattern" : "no-route-match", unsupportedMatches));
      continue;
    }
    const exact = methodMatches.filter(item => item.match === "exact");
    const selected = exact.length ? exact : methodMatches.filter(item => item.match === "parameterized");
    if (selected.length > 1) {
      matches.push(make("ambiguous", "multiple-routes", selected));
      continue;
    }
    const candidate = selected[0];
    addEdge(endpoint.id, candidate.route.id, "calls-route", endpoint.ref, "inferred", "cross-stack-static-path-v1");
    if (candidate.route.adapter === "codeigniter-3" && candidate.match === "parameterized") {
      const dispatch = addStaticCodeIgniterDispatchEdges(endpoint, candidate.route, phpFiles, phpSymbols, hasNode, addEdge);
      if (dispatch !== "resolved") {
        dispatchDiagnostics.push(`Static CodeIgniter route dispatch ${dispatch} at ${endpoint.ref.path}:${endpoint.ref.startLine}.`);
      }
    }
    matches.push(make(candidate.match === "exact" ? "exact" : "parameterized", undefined, [candidate]));
  }
  return { totalHttpCalls: endpoints.length, omittedHttpCalls: Math.max(0, endpoints.length - MAX_CORRELATIONS), matches, dispatchDiagnostics };
}

function resolvePhpType(
  rawType: string,
  file: PhpParsedFile,
  symbols: readonly PhpSymbol[],
  namespace?: string,
  absolute = false,
): PhpSymbol | undefined {
  const isAbsolute = absolute || rawType.startsWith("\\");
  const name = rawType.replace(/^\\+|\\+$/g, "");
  const classes = symbols.filter(symbol => ["class", "interface", "trait", "enum"].includes(symbol.kind));
  const imports = new Map(file.symbols.filter(symbol => symbol.kind === "import" && symbol.importType === "class" && symbol.namespace === namespace)
    .map(symbol => [symbol.alias ?? symbol.name.split("\\").at(-1)!, symbol.name]));
  const [head, ...tail] = name.split("\\");
  const imported = imports.get(head);
  const resolvedName = imported
    ? [imported, ...tail].join("\\")
    : isAbsolute || !namespace
      ? name
      : `${namespace}\\${name}`;
  const candidates = classes.filter(symbol => symbol.name.toLowerCase() === resolvedName.toLowerCase());
  return candidates.length === 1 ? candidates[0] : undefined;
}

function callParts(node: Ast): { ownerProperty: string; method: string } | undefined {
  if (node.kind !== "call" || !isAst(node.what) || node.what.kind !== "propertylookup") return undefined;
  const method = nameOf(node.what.offset);
  const receiver = node.what.what;
  if (!method || !isAst(receiver) || receiver.kind !== "propertylookup" || !isAst(receiver.what) ||
      receiver.what.kind !== "variable" || nameOf(receiver.what) !== "this") return undefined;
  const ownerProperty = nameOf(receiver.offset);
  return ownerProperty ? { ownerProperty, method } : undefined;
}

function sameClassCallName(node: Ast): string | undefined {
  if (node.kind !== "call" || !isAst(node.what) || node.what.kind !== "propertylookup" ||
      !isAst(node.what.what) || node.what.what.kind !== "variable" || nameOf(node.what.what) !== "this") return undefined;
  return nameOf(node.what.offset);
}

function staticCodeIgniterParameter(frontendPath: string, routePath: string, parameter: number): string | undefined {
  const request = normalizeConcretePath(frontendPath);
  if (request === undefined) return undefined;
  const requestSegments = pathSegments(request);
  const routeSegments = pathSegments(routePath.replace(/^\/+|\/+$/g, ""));
  if (requestSegments.length !== routeSegments.length) return undefined;
  let routeParameter = 0;
  for (let index = 0; index < routeSegments.length; index++) {
    const segment = routeSegments[index];
    if (/^\(:[A-Za-z]+\)$/.test(segment)) {
      routeParameter++;
      if (routeParameter === parameter) return requestSegments[index];
    } else if (segment !== requestSegments[index]) return undefined;
  }
  return undefined;
}

function phpMethodAst(file: PhpParsedFile, symbol: PhpSymbol): Ast | undefined {
  if (!file.ast) return undefined;
  const matches: Ast[] = [];
  walkAst(file.ast, node => {
    if (node.kind === "method" && nameOf(node.name)?.toLowerCase() === symbol.name.toLowerCase() &&
        sourceOf(file.path, node).startLine === symbol.source.startLine) matches.push(node);
  }, 100_000);
  return matches.length === 1 ? matches[0] : undefined;
}

function phpParameterName(parameter: unknown): string | undefined {
  if (!isAst(parameter) || parameter.kind !== "parameter" || !isAst(parameter.name) || parameter.name.kind !== "identifier") return undefined;
  return nameOf(parameter.name);
}

function phpStatements(value: unknown): Ast[] {
  if (Array.isArray(value)) return value.filter(isAst);
  return isAst(value) && value.kind === "block" && Array.isArray(value.children) ? value.children.filter(isAst) : [];
}

function addStaticCodeIgniterDispatchEdges(
  endpoint: JavaScriptAnalysis["endpoints"][number],
  route: RouteEvidence,
  files: readonly PhpParsedFile[],
  symbols: readonly PhpSymbol[],
  hasNode: (id: string) => boolean,
  addEdge: AddEdge,
): "resolved" | "unresolved" | "ambiguous" {
  const parameterBinding = route.parameterBindings?.find(binding => binding.argument === 1);
  if (!parameterBinding || !route.resolvedMethod) return "unresolved";
  const value = staticCodeIgniterParameter(endpoint.path ?? "", route.path ?? "", parameterBinding.routeParameter);
  if (!value) return "unresolved";
  const separator = route.resolvedMethod.lastIndexOf("#");
  if (separator <= 0) return "unresolved";
  const methodPath = route.resolvedMethod.slice(0, separator), methodName = route.resolvedMethod.slice(separator + 1);
  const callerSymbols = symbols.filter(symbol => symbol.kind === "method" && symbol.source.path === methodPath && symbol.name === methodName);
  if (callerSymbols.length !== 1) return callerSymbols.length > 1 ? "ambiguous" : "unresolved";
  const callerSymbol = callerSymbols[0];
  const file = files.find(item => item.path === methodPath);
  const callerAst = file && phpMethodAst(file, callerSymbol);
  if (!callerAst || !Array.isArray(callerAst.arguments)) return "unresolved";
  const parameterName = phpParameterName(callerAst.arguments[parameterBinding.argument - 1]);
  if (!parameterName || !isAst(callerAst.body)) return "unresolved";
  const caller = `method:${methodPath}#${callerSymbol.name}`;
  if (!hasNode(caller)) return "unresolved";

  const switches: Ast[] = [];
  walkAst(callerAst.body, node => {
    if (node.kind === "switch" && isAst(node.test) && node.test.kind === "variable" && nameOf(node.test) === parameterName) switches.push(node);
  }, 100_000);
  if (switches.length !== 1) return switches.length > 1 ? "ambiguous" : "unresolved";
  addEdge(route.id, caller, "binds-route-parameter", route.source, "observed", "codeigniter-static-parameter-v1");
  const switchCases = phpStatements(switches[0].body).filter(item =>
    item.kind === "case" && isAst(item.test) && item.test.kind === "string" && item.test.value === value);
  if (switchCases.length !== 1) return switchCases.length > 1 ? "ambiguous" : "unresolved";
  const statements = phpStatements(switchCases[0].body);
  const calledMethods = statements.flatMap(statement =>
    statement.kind === "expressionstatement" && isAst(statement.expression)
      ? sameClassCallName(statement.expression) ? [{ name: sameClassCallName(statement.expression)!, node: statement.expression }] : []
      : []);
  if (calledMethods.length !== 1) return calledMethods.length > 1 ? "ambiguous" : "unresolved";
  const targetSymbols = symbols.filter(symbol => symbol.kind === "method" && symbol.owner === callerSymbol.owner &&
    symbol.source.path === methodPath && symbol.name === calledMethods[0].name);
  const sameNameSymbols = symbols.filter(symbol => symbol.kind === "method" && symbol.source.path === methodPath &&
    symbol.name === calledMethods[0].name);
  if (targetSymbols.length !== 1 || sameNameSymbols.length !== 1) return targetSymbols.length > 1 ? "ambiguous" : "unresolved";
  const target = `method:${methodPath}#${targetSymbols[0].name}`;
  if (!hasNode(target)) return "unresolved";
  addEdge(caller, target, "dispatches-to", sourceOf(methodPath, calledMethods[0].node), "observed", "php-switch-route-dispatch-v1");
  return "resolved";
}

function walkAst(root: unknown, visit: (node: Ast) => void, maxNodes: number): number {
  const pending: unknown[] = [root];
  let visited = 0;
  while (pending.length && visited < maxNodes) {
    const current = pending.pop();
    if (!isAst(current)) continue;
    visited++;
    visit(current);
    for (const [key, value] of Object.entries(current)) {
      if (key === "loc" || key === "errors") continue;
      if (isAst(value)) pending.push(value);
      else if (Array.isArray(value)) pending.push(...value);
    }
  }
  return visited;
}

export function addTypedPhpMethodCallEdges(
  files: readonly PhpParsedFile[],
  symbols: readonly PhpSymbol[],
  hasNode: (id: string) => boolean,
  addEdge: AddEdge,
): { observed: number; unresolved: number; unsupported: string[] } {
  let observed = 0;
  let unresolved = 0;
  let remaining = MAX_PHP_CALL_NODES;
  for (const file of files) {
    if (!file.ast || file.status !== "complete" || remaining <= 0) continue;
    const classes = symbols.filter(symbol => symbol.kind === "class" && symbol.source.path === file.path);
    const classNodes: Ast[] = [];
    const indexedNodes = walkAst(file.ast, classNode => {
      if (classNode.kind === "class") classNodes.push(classNode);
    }, remaining);
    remaining -= indexedNodes;
    for (const classNode of classNodes) {
      if (remaining <= 0) break;
      if (classNode.isAnonymous === true) continue;
      const classLine = sourceOf(file.path, classNode).startLine;
      const className = nameOf(classNode.name);
      const ownerClass = classes.find(symbol => symbol.source.startLine === classLine && symbol.name.split("\\").at(-1) === className);
      if (!ownerClass || !Array.isArray(classNode.body)) continue;
      const properties = new Map<string, PhpSymbol | undefined>();
      const methods = ownerClass ? symbols.filter(symbol => symbol.kind === "method" && symbol.owner === ownerClass.name && symbol.source.path === file.path) : [];
      for (const member of classNode.body) {
        if (!isAst(member) || member.kind !== "propertystatement" || !Array.isArray(member.properties)) continue;
        for (const property of member.properties) {
          if (!isAst(property) || !isAst(property.type) || property.type.kind !== "name") continue;
          const propertyName = nameOf(property.name);
          const typeName = nameOf(property.type);
          if (propertyName && typeName) properties.set(propertyName, resolvePhpType(
            typeName,
            file,
            symbols,
            ownerClass.namespace,
            property.type.resolution === "fqn",
          ));
        }
      }
      for (const member of classNode.body) {
        if (!isAst(member) || member.kind !== "method" || !isAst(member.body)) continue;
        if (remaining <= 0) break;
        const methodName = nameOf(member.name);
        const sourceRef = sourceOf(file.path, member);
        const callerMethods = methods.filter(symbol => symbol.name === methodName && symbol.source.startLine === sourceRef.startLine);
        const sameNameCallerMethods = symbols.filter(symbol => symbol.kind === "method" && symbol.source.path === file.path && symbol.name === methodName);
        const caller = callerMethods.length === 1 && sameNameCallerMethods.length === 1 ? `method:${file.path}#${methodName}` : undefined;
        const visited = walkAst(member.body, callNode => {
          const directMethod = sameClassCallName(callNode);
          if (directMethod) {
            const targetMethods = methods.filter(symbol => symbol.name === directMethod);
            const sameNameTargetMethods = symbols.filter(symbol => symbol.kind === "method" && symbol.source.path === file.path && symbol.name === directMethod);
            if (caller && targetMethods.length === 1 && sameNameTargetMethods.length === 1) {
              const target = `method:${targetMethods[0].source.path}#${targetMethods[0].name}`;
              if (hasNode(caller) && hasNode(target)) {
                addEdge(caller, target, "calls-php-method", sourceOf(file.path, callNode), "observed", "php-same-class-call-v1");
                observed++;
                return;
              }
            }
            unresolved++;
            return;
          }
          const call = callParts(callNode);
          if (!call) return;
          const targetClass = properties.get(call.ownerProperty);
          if (!caller || !targetClass) {
            unresolved++;
            return;
          }
          const targetMethods = symbols.filter(symbol => symbol.kind === "method" && symbol.owner === targetClass.name && symbol.name === call.method);
          const sameNameTargetMethods = symbols.filter(symbol => symbol.kind === "method" && symbol.source.path === targetMethods[0]?.source.path && symbol.name === call.method);
          if (targetMethods.length !== 1 || sameNameTargetMethods.length !== 1) {
            unresolved++;
            return;
          }
          const target = `method:${targetMethods[0].source.path}#${targetMethods[0].name}`;
          if (!hasNode(caller) || !hasNode(target)) {
            unresolved++;
            return;
          }
          addEdge(caller, target, "calls-php-method", sourceOf(file.path, callNode), "observed", "php-typed-property-call-v1");
          observed++;
        }, Math.min(remaining, 100_000));
        remaining -= visited;
      }
    }
  }
  return { observed, unresolved, unsupported: unsupportedPhpCalls };
}
