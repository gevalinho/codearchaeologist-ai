import type { PhpAdapterContext, PhpAdapterResult, PhpAdapterSummary, PhpDetectionConfidence, PhpFrameworkAdapter, PhpRouteEvidence } from "./adapters";
import type { PhpParsedFile, PhpSourceRef, PhpSymbol } from "./parser";

type Ast = Record<string, unknown> & { kind: string };
type RouteAdapterId = "codeigniter-3" | "codeigniter-4" | "laravel";
type CandidateRoute = PhpRouteEvidence & { controller?: string; action?: string };
type GroupContext = { prefix: string; middleware: string[]; dynamicPrefix: boolean; routeVariables: string[] };
type CallPart = { name: string; args: unknown[] };
type InternalResult = { routes: CandidateRoute[]; summary: PhpAdapterSummary; issues: { code: string; source?: PhpRouteEvidence["source"] }[] };

const routeAdapters: { id: RouteAdapterId; display: string; canonicalPaths: readonly string[] }[] = [
  { id: "codeigniter-3", display: "CodeIgniter 3", canonicalPaths: ["application/config/routes.php"] },
  { id: "codeigniter-4", display: "CodeIgniter 4", canonicalPaths: ["app/Config/Routes.php"] },
  { id: "laravel", display: "Laravel", canonicalPaths: ["routes/web.php", "routes/api.php"] },
];
const routeMethods = new Set(["get", "post", "put", "patch", "delete", "match", "any"]);
const codeIgniter4Methods = new Set(["get", "post", "put", "delete", "match"]);
const unsupportedRouteForms = new Set(["patch", "any", "resource", "apiresource", "options", "head", "fallback", "redirect", "view", "controller", "add"]);
const routeChainMethods = new Set(["prefix", "middleware", "group", "name", "as", "where", "wherenumber", "wherealpha", "wherealphanumeric", "whereuuid", "whereulid", "wherein", "domain", "namespace", "withoutmiddleware", "scopebindings", "withtrashed", "missing", "binding", "pattern", "model", "can", "defaults"]);
const MAX_ADAPTER_ROUTES = 600;
const ciPlaceholders = new Set(["num", "alpha", "alphanum", "any", "segment", "all"]);
const resourceParameters = new Map([["orders", "order"], ["users", "user"], ["products", "product"], ["items", "item"], ["posts", "post"]]);
const RESOURCE_ACTIONS = [
  { suffix: "", methods: ["GET"], action: "index" },
  { suffix: "/create", methods: ["GET"], action: "create" },
  { suffix: "", methods: ["POST"], action: "store" },
  { suffix: "/{parameter}", methods: ["GET"], action: "show" },
  { suffix: "/{parameter}/edit", methods: ["GET"], action: "edit" },
  { suffix: "/{parameter}", methods: ["PUT", "PATCH"], action: "update" },
  { suffix: "/{parameter}", methods: ["DELETE"], action: "destroy" },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAst(value: unknown): value is Ast {
  return isRecord(value) && typeof value.kind === "string";
}

function nodeName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isRecord(value) && typeof value.name === "string" ? value.name : undefined;
}

function sourceRef(file: PhpParsedFile, node: Ast): PhpSourceRef {
  const loc = isRecord(node.loc) ? node.loc : {};
  const start = isRecord(loc.start) ? loc.start : {};
  const end = isRecord(loc.end) ? loc.end : {};
  const startLine = Number.isSafeInteger(start.line) && (start.line as number) > 0 ? start.line as number : 1;
  const endLine = Number.isSafeInteger(end.line) && (end.line as number) >= startLine ? end.line as number : startLine;
  const startColumn = Number.isSafeInteger(start.column) && (start.column as number) >= 0 ? start.column as number : 0;
  const endColumn = Number.isSafeInteger(end.column) && (end.column as number) >= 0 ? end.column as number : startColumn;
  return { path: file.path, startLine, endLine, startColumn, endColumn };
}

function staticString(value: unknown): string | undefined {
  return isAst(value) && value.kind === "string" && typeof value.value === "string" && value.value.length <= 500 ? value.value : undefined;
}

function laravelRouteRoot(root: string | undefined, file: PhpParsedFile): boolean {
  if (!root) return false;
  const normalized = normalizeClassName(root).toLowerCase();
  if (normalized === "route" || normalized.endsWith("\\illuminate\\support\\facades\\route")) return true;
  return file.symbols.some(symbol => symbol.kind === "import" && symbol.importType === "class" &&
    (symbol.alias ?? symbol.name.split("\\").at(-1))?.toLowerCase() === normalized &&
    /(?:^|\\)(?:illuminate\\support\\facades\\route|illuminate\\routing\\router)$/i.test(symbol.name));
}

function routeRootMatches(root: string | undefined, file: PhpParsedFile, adapter: RouteAdapterId, routeVariables: readonly string[]): boolean {
  if (adapter === "laravel") return laravelRouteRoot(root, file);
  return !!root && routeVariables.includes(root.replace(/^\$/, "").toLowerCase());
}

function closureParameterNames(closure: Ast): string[] {
  if (!Array.isArray(closure.arguments)) return [];
  return closure.arguments.flatMap(argument => {
    if (!isAst(argument)) return [];
    const name = nodeName(argument.name);
    return name ? [name.toLowerCase()] : [];
  });
}

function callPart(value: unknown): CallPart | undefined {
  if (!isAst(value) || value.kind !== "call" || !Array.isArray(value.arguments) || !isAst(value.what)) return undefined;
  const callable = value.what;
  if (callable.kind !== "staticlookup" && callable.kind !== "propertylookup") return undefined;
  const name = nodeName(callable.offset);
  if (!name) return undefined;
  return { name: name.toLowerCase(), args: value.arguments };
}

function callChain(value: unknown): { root: string | undefined; calls: { part: CallPart; node: Ast }[] } {
  if (!isAst(value) || value.kind !== "call" || !isAst(value.what)) return { root: undefined, calls: [] };
  const callable = value.what;
  const receiver = callable.kind === "staticlookup" || callable.kind === "propertylookup" ? callable.what : undefined;
  const previous = isAst(receiver) && receiver.kind === "call" ? callChain(receiver) : { root: undefined, calls: [] };
  const part = callPart(value);
  const base = nodeName(receiver);
  return {
    root: previous.root ?? base,
    calls: part ? [...previous.calls, { part, node: value }] : previous.calls,
  };
}

function closureArgument(args: unknown[]): Ast | undefined {
  return [...args].reverse().find(value => isAst(value) && (value.kind === "closure" || value.kind === "arrowfunc")) as Ast | undefined;
}

function arrayStrings(value: unknown): string[] | undefined {
  if (!isAst(value) || value.kind !== "array" || !Array.isArray(value.items)) return undefined;
  const result: string[] = [];
  for (const item of value.items) {
    if (!isAst(item) || item.kind !== "entry") return undefined;
    const literal = staticString(item.value);
    if (literal === undefined) return undefined;
    result.push(literal);
  }
  return result;
}

function arrayOptions(value: unknown): Record<string, string | string[]> | undefined {
  if (!isAst(value) || value.kind !== "array" || !Array.isArray(value.items)) return undefined;
  const result: Record<string, string | string[]> = {};
  for (const item of value.items) {
    if (!isAst(item) || item.kind !== "entry") return undefined;
    const key = staticString(item.key);
    if (!key) continue;
    const valueString = staticString(item.value);
    const valueStrings = arrayStrings(item.value);
    if (valueString !== undefined) result[key] = valueString;
    else if (valueStrings) result[key] = valueStrings;
    else return undefined;
  }
  return result;
}

function joinedPath(prefix: string, value: string): string {
  const joined = [prefix, value].filter(Boolean).join("/");
  return `/${joined}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function staticPath(value: string | undefined, framework: RouteAdapterId): boolean {
  if (value === undefined || value.includes("\0") || value.includes("$")) return false;
  if (framework === "laravel") return !/[<>\[\]]/.test(value);
  for (const match of value.matchAll(/\(:([A-Za-z]+)\)/g)) if (!ciPlaceholders.has(match[1].toLowerCase())) return false;
  return !/[{}]/.test(value);
}

function normalizeClassName(value: string): string {
  const normalized = value.replace(/^\\+|\\+$/g, "").trim();
  return normalized.length <= 250 ? normalized : "";
}

function classReference(value: unknown): string | undefined {
  if (!isAst(value)) return undefined;
  if (value.kind === "staticlookup" && nodeName(value.offset)?.toLowerCase() === "class") {
    return normalizeClassName(nodeName(value.what) ?? "");
  }
  if (value.kind === "classconstant" && String(value.name).toLowerCase() === "class") {
    return normalizeClassName(nodeName(value.what) ?? "");
  }
  if (value.kind === "string") {
    const literal = staticString(value);
    if (literal === undefined) return undefined;
    const split = /^(.*?)\s*(?:::|@|\/)\s*([A-Za-z_]\w*)(?:\/\$\d+)?$/.exec(literal);
    return split?.[1] ? normalizeClassName(split[1]) : undefined;
  }
  return undefined;
}

function callableTarget(value: unknown): { controller?: string; action?: string } {
  if (isAst(value) && value.kind === "array" && Array.isArray(value.items) && value.items.length === 2) {
    const values = value.items.map(item => isAst(item) && item.kind === "entry" ? item.value : undefined);
    const controller = classReference(values[0]);
    const action = staticString(values[1]);
    return controller && action && action.length <= 100 && /^[A-Za-z_]\w*$/.test(action) ? { controller, action } : {};
  }
  if (isAst(value) && value.kind === "string") {
    const literal = staticString(value)?.replace(/\/\$\d+$/, "");
    if (!literal) return {};
    const match = /^(.*?)\s*(?:::|@|\/)\s*([A-Za-z_]\w*)$/.exec(literal);
    if (match?.[1]) {
      const controller = normalizeClassName(match[1]);
      return controller && match[2].length <= 100 ? { controller, action: match[2] } : {};
    }
    if (/^[A-Za-z_][A-Za-z0-9_\\]*$/.test(literal)) {
      const controller = normalizeClassName(literal);
      return controller ? { controller, action: undefined } : {};
    }
  }
  return {};
}

function resolveClassName(raw: string, file: PhpParsedFile, symbols: readonly PhpSymbol[]): string | undefined {
  const classSymbols = symbols.filter(symbol => symbol.kind === "class");
  const name = normalizeClassName(raw);
  const routeNamespace = file.symbols.find(symbol => symbol.kind === "namespace")?.name;
  const imports = new Map(file.symbols.filter(symbol => symbol.kind === "import" && symbol.importType === "class")
    .map(symbol => [symbol.alias ?? symbol.name.split("\\").at(-1)!, symbol.name]));
  const aliased = imports.get(name);
  if (aliased) return aliased;
  if (name.includes("\\")) {
    const exact = classSymbols.find(symbol => symbol.name.toLowerCase() === name.toLowerCase());
    return exact?.name ?? name;
  }
  if (routeNamespace && classSymbols.some(symbol => symbol.name.toLowerCase() === `${routeNamespace}\\${name}`.toLowerCase())) return `${routeNamespace}\\${name}`;
  const matching = classSymbols.filter(symbol => symbol.name.split("\\").at(-1)?.toLowerCase() === name.toLowerCase());
  return matching.length === 1 ? matching[0].name : name;
}

function resolveRoute(route: CandidateRoute, file: PhpParsedFile, symbols: readonly PhpSymbol[]): PhpRouteEvidence {
  if (route.resolution === "dynamic" || route.resolution === "ambiguous") return route;
  if (!route.controller || !route.action) return { ...route, resolution: "unresolved" };
  const resolvedClass = resolveClassName(route.controller, file, symbols);
  const classes = symbols.filter(symbol => symbol.kind === "class" && symbol.name.toLowerCase() === resolvedClass?.toLowerCase());
  if (classes.length > 1) return { ...route, resolution: "ambiguous" };
  if (classes.length !== 1) {
    const basenameMatches = symbols.filter(symbol => symbol.kind === "class" && symbol.name.split("\\").at(-1)?.toLowerCase() === route.controller?.split("\\").at(-1)?.toLowerCase());
    return { ...route, resolution: basenameMatches.length > 1 ? "ambiguous" : "unresolved" };
  }
  const methods = symbols.filter(symbol => symbol.kind === "method" && symbol.owner?.toLowerCase() === classes[0].name.toLowerCase() && symbol.name.toLowerCase() === route.action?.toLowerCase());
  if (methods.length > 1) return { ...route, resolution: "ambiguous" };
  if (methods.length !== 1) return { ...route, resolution: "unresolved" };
  const resolvedMethod = methods[0];
  const resolvedTarget = `${classes[0].name}@${resolvedMethod.name}`;
  const resolvedMethodRef = `${resolvedMethod.source.path}#${resolvedMethod.name}`;
  if (resolvedTarget.length > 300 || resolvedMethodRef.length > 500) return { ...route, resolution: "unresolved", target: undefined };
  return {
    adapter: route.adapter,
    ...(route.path ? { path: route.path } : {}),
    methods: route.methods,
    target: resolvedTarget,
    middleware: route.middleware,
    source: route.source,
    certainty: route.certainty,
    resolution: "resolved",
    resolvedMethod: resolvedMethodRef,
    ...(route.parameterBindings ? { parameterBindings: route.parameterBindings } : {}),
  };
}

function classTargetForResource(value: unknown): string | undefined {
  if (!isAst(value)) return undefined;
  const reference = classReference(value);
  if (reference) return reference;
  return staticString(value);
}

function methodList(name: string, args: unknown[], framework: RouteAdapterId): { methods?: string[]; pathArgument?: unknown; targetArgument?: unknown } {
  if (name === "match") {
    const methods = arrayStrings(args[0]);
    const normalized = methods?.map(method => method.toUpperCase());
    const supported = framework === "codeigniter-4"
      ? new Set(["GET", "POST", "PUT", "DELETE"])
      : new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    return { methods: normalized?.length && normalized.every(method => supported.has(method)) ? normalized : undefined, pathArgument: args[1], targetArgument: args[2] };
  }
  return {
    methods: name === "any" ? ["ANY"] : [name.toUpperCase()],
    pathArgument: args[0],
    targetArgument: args[1],
  };
}

function routeOptions(chain: { part: CallPart; node: Ast }[], args: unknown[], framework: RouteAdapterId, inherited: GroupContext, file: PhpParsedFile, issues: InternalResult["issues"]): GroupContext {
  let prefix = inherited.prefix;
  let dynamicPrefix = inherited.dynamicPrefix;
  const middleware = [...inherited.middleware];
  const addMiddleware = (values: string | string[], node: Ast) => {
    const candidates = typeof values === "string" ? [values] : values;
    for (const value of candidates) {
      if (value.length > 100) issues.push({ code: "route-middleware-limit", source: sourceRef(file, node) });
      else middleware.push(value);
    }
  };
  for (const item of chain) {
    if (item.part.name === "prefix") {
      const value = staticString(item.part.args[0]);
      if (value !== undefined) prefix = joinedPath(prefix, value).replace(/^\/+/, "");
      else {
        dynamicPrefix = true;
        issues.push({ code: "dynamic-route-prefix", source: sourceRef(file, item.node) });
      }
    }
    if (item.part.name === "middleware") {
      const values = staticString(item.part.args[0]) ?? arrayStrings(item.part.args[0]);
      if (typeof values === "string") addMiddleware(values, item.node);
      else if (values) addMiddleware(values, item.node);
      else issues.push({ code: "dynamic-route-middleware", source: sourceRef(file, item.node) });
    }
  }
  if (framework === "laravel" && args[0] && isAst(args[0]) && args[0].kind === "array") {
    const options = arrayOptions(args[0]);
    if (options?.prefix) prefix = joinedPath(prefix, options.prefix as string).replace(/^\/+/, "");
    if (!options) {
      dynamicPrefix = true;
      issues.push({ code: "dynamic-route-group-options", source: sourceRef(file, chain.at(-1)!.node) });
    }
    const configuredMiddleware = options?.middleware;
    if (typeof configuredMiddleware === "string") addMiddleware(configuredMiddleware, chain.at(-1)!.node);
    else if (configuredMiddleware) addMiddleware(configuredMiddleware, chain.at(-1)!.node);
    else if (options && "middleware" in options) issues.push({ code: "dynamic-route-middleware", source: sourceRef(file, chain.at(-1)!.node) });
  } else if (framework === "codeigniter-4") {
    const groupPrefix = staticString(args[0]);
    if (groupPrefix !== undefined) prefix = joinedPath(prefix, groupPrefix).replace(/^\/+/, "");
    else if (args[0] !== undefined) {
      dynamicPrefix = true;
      issues.push({ code: "dynamic-route-prefix", source: sourceRef(file, chain.at(-1)!.node) });
    }
    if (!args[1] || !isAst(args[1]) || args[1].kind !== "array") return { prefix, middleware: [...new Set(middleware)].slice(0, 20), dynamicPrefix, routeVariables: inherited.routeVariables };
    const options = arrayOptions(args[1]);
    if (!options) issues.push({ code: "dynamic-route-group-options", source: sourceRef(file, chain.at(-1)!.node) });
    const filters = options?.filter ?? options?.filters;
    if (typeof filters === "string") addMiddleware(filters, chain.at(-1)!.node);
    else if (filters) addMiddleware(filters, chain.at(-1)!.node);
    else if (options && ("filter" in options || "filters" in options)) issues.push({ code: "dynamic-route-middleware", source: sourceRef(file, chain.at(-1)!.node) });
  }
  return { prefix, middleware: [...new Set(middleware)].slice(0, 20), dynamicPrefix, routeVariables: inherited.routeVariables };
}

function addRoute(routes: CandidateRoute[], file: PhpParsedFile, adapter: RouteAdapterId, callNode: Ast, uri: unknown, methods: string[], target: unknown, context: GroupContext, certainty: "observed" | "inferred" = "observed"): void {
  const literalPath = staticString(uri);
  const joined = literalPath !== undefined ? joinedPath(context.prefix, literalPath) : undefined;
  const pathIsStatic = !context.dynamicPrefix && staticPath(literalPath, adapter) && !!joined && joined.length <= 500;
  const path = pathIsStatic ? joined : undefined;
  const callable = callableTarget(target);
  const candidateTarget = staticString(target) ?? (callable.controller ? `${callable.controller}${callable.action ? `@${callable.action}` : ""}` : undefined);
  const targetName = candidateTarget && candidateTarget.length <= 300 ? candidateTarget : undefined;
  routes.push({
    adapter,
    ...(path ? { path } : {}),
    methods,
    ...(targetName ? { target: targetName } : {}),
    middleware: context.middleware,
    source: sourceRef(file, callNode),
    certainty,
    resolution: !pathIsStatic || literalPath === undefined ? "dynamic" : "unresolved",
    ...(callable.controller ? { controller: callable.controller } : {}),
    ...(callable.action ? { action: callable.action } : {}),
  });
}

function extractResource(routes: CandidateRoute[], file: PhpParsedFile, callNode: Ast, args: unknown[], context: GroupContext, issues: InternalResult["issues"]): boolean {
  const resource = staticString(args[0]);
  const rawController = classTargetForResource(args[1]);
  const finalPart = resource?.split("/").at(-1);
  const parameter = finalPart ? resourceParameters.get(finalPart) : undefined;
  if (!resource || !rawController || !parameter || !/^[A-Za-z0-9/_-]+$/.test(resource) || context.dynamicPrefix) {
    routes.push({
      adapter: "laravel",
      ...(resource && !context.dynamicPrefix && joinedPath(context.prefix, resource).length <= 500 ? { path: joinedPath(context.prefix, resource) } : {}),
      methods: [],
      ...(rawController ? { target: rawController } : {}),
      middleware: context.middleware,
      source: sourceRef(file, callNode),
      certainty: "observed",
      resolution: resource && !context.dynamicPrefix ? "ambiguous" : "dynamic",
      ...(rawController ? { controller: rawController } : {}),
    });
    return true;
  }
  if (routes.length + RESOURCE_ACTIONS.length > MAX_ADAPTER_ROUTES) {
    issues.push({ code: "route-count-limit", source: sourceRef(file, callNode) });
    return true;
  }
  for (const action of RESOURCE_ACTIONS) {
    const suffix = action.suffix.replace("{parameter}", `{${parameter}}`);
    const routePath = joinedPath(context.prefix, `${resource}${suffix}`);
    if (routePath.length > 500) {
      routes.push({
        adapter: "laravel",
        methods: [],
        target: rawController,
        middleware: context.middleware,
        source: sourceRef(file, callNode),
        certainty: "observed",
        resolution: "ambiguous",
        controller: rawController,
      });
      return true;
    }
    routes.push({
      adapter: "laravel",
      path: routePath,
      methods: [...action.methods],
      target: `${rawController}@${action.action}`,
      middleware: context.middleware,
      source: sourceRef(file, callNode),
      certainty: "inferred",
      resolution: "unresolved",
      controller: rawController,
      action: action.action,
    });
  }
  return true;
}

function ci3Routes(file: PhpParsedFile, issues: InternalResult["issues"]): CandidateRoute[] {
  if (!file.ast) return [];
  const routes: CandidateRoute[] = [];
  const pending: unknown[] = [file.ast];
  let visited = 0;
  while (pending.length && visited < 100_000) {
    const current = pending.pop();
    if (!isAst(current)) continue;
    visited++;
    if (current.kind === "assign" && current.operator === "=" && isAst(current.left) && current.left.kind === "offsetlookup" &&
      isAst(current.left.what) && current.left.what.kind === "variable" && current.left.what.name === "route") {
      if (routes.length >= MAX_ADAPTER_ROUTES) {
        issues.push({ code: "route-count-limit", source: sourceRef(file, current) });
        pending.length = 0;
        break;
      }
      const routePath = staticString(current.left.offset);
      const target = staticString(current.right);
      const source = sourceRef(file, current);
      const pathParameterCount = routePath?.match(/\(:[A-Za-z]+\)/g)?.length ?? 0;
      const targetParts = target?.split("/").filter(Boolean) ?? [];
      const parameterReferences = [...(target?.matchAll(/\$(\d+)/g) ?? [])].map(match => Number(match[1]));
      const invalidParameterReference = parameterReferences.some(parameter => parameter < 1 || parameter > pathParameterCount);
      if (invalidParameterReference) issues.push({ code: "unsupported-route-parameter-substitution", source });
      const parameterBindings = targetParts.slice(2).flatMap((part, index) => {
        const parameter = /^\$(\d+)$/.exec(part);
        return parameter && Number(parameter[1]) <= pathParameterCount
          ? [{ routeParameter: Number(parameter[1]), argument: index + 1 }]
          : [];
      });
      const normalizedTarget = target?.replace(/\/\$\d+/g, "");
      const parts = normalizedTarget?.split("/").filter(Boolean) ?? [];
      const controller = parts.length <= 2 ? parts[0] : undefined;
      const action = parts.length <= 2 ? parts[1] ?? (controller ? "index" : undefined) : undefined;
      const staticDeclaration = routePath !== undefined && staticPath(routePath, "codeigniter-3");
      const boundedPath = !!routePath && routePath.length <= 500;
      routes.push({
        adapter: "codeigniter-3",
        ...(staticDeclaration && boundedPath && routePath ? { path: joinedPath("", routePath) } : {}),
        methods: ["ANY"],
        ...(normalizedTarget && normalizedTarget.length <= 300 ? { target: normalizedTarget } : {}),
        middleware: [],
        source,
        certainty: action && parts.length < 2 ? "inferred" : "observed",
        resolution: routePath === undefined || !staticDeclaration || !boundedPath ? "dynamic" : invalidParameterReference || parts.length > 2 ? "ambiguous" : "unresolved",
        ...(controller ? { controller } : {}),
        ...(action ? { action } : {}),
        ...(parameterBindings.length ? { parameterBindings } : {}),
      });
    }
    for (const value of Object.values(current)) {
      if (value === current.loc || value === current.errors) continue;
      if (isAst(value)) pending.push(value);
      else if (Array.isArray(value)) pending.push(...value);
    }
  }
  if (pending.length && !issues.some(issue => issue.code === "adapter-node-limit" && issue.source?.path === file.path)) {
    issues.push({ code: "adapter-node-limit", source: { path: file.path, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 } });
  }
  return routes;
}

function collectStatements(node: unknown, file: PhpParsedFile, adapter: RouteAdapterId, context: GroupContext, routes: CandidateRoute[], issues: InternalResult["issues"], depth = 0, budget = { remaining: 100_000 }): void {
  if (!isAst(node)) return;
  if (depth > 256) {
    if (!issues.some(issue => issue.code === "adapter-depth-limit" && issue.source?.path === file.path)) issues.push({ code: "adapter-depth-limit", source: sourceRef(file, node) });
    return;
  }
  if (budget.remaining <= 0) {
    if (!issues.some(issue => issue.code === "adapter-node-limit" && issue.source?.path === file.path)) issues.push({ code: "adapter-node-limit", source: sourceRef(file, node) });
    return;
  }
  budget.remaining--;
  const children = node.kind === "program" || node.kind === "block" || node.kind === "namespace"
    ? Array.isArray(node.children) ? node.children : []
    : [];
  for (const child of children) {
    if (!isAst(child)) continue;
    if (routes.length >= MAX_ADAPTER_ROUTES) {
      if (!issues.some(issue => issue.code === "route-count-limit" && issue.source?.path === file.path)) {
        issues.push({ code: "route-count-limit", source: sourceRef(file, child) });
      }
      return;
    }
    const expression = child.kind === "expressionstatement" ? child.expression : child;
    if (isAst(expression) && expression.kind === "call") {
      const chain = callChain(expression);
      const final = chain.calls.at(-1);
      const root = chain.root?.replace(/^\\+/, "");
      const allowedRoot = routeRootMatches(root, file, adapter, context.routeVariables);
      if (final && allowedRoot && final.part.name === "group") {
        const callback = closureArgument(final.part.args);
        if (callback) {
          const nested = routeOptions(chain.calls, final.part.args, adapter, context, file, issues);
          if (adapter === "codeigniter-4") nested.routeVariables = [...new Set([...context.routeVariables, ...closureParameterNames(callback)])];
          collectStatements(callback.body, file, adapter, nested, routes, issues, depth + 1, budget);
          continue;
        }
        issues.push({ code: "dynamic-route-group", source: sourceRef(file, expression) });
      } else if (final && allowedRoot && adapter === "laravel" && final.part.name === "resource") {
        const routeContext = routeOptions(chain.calls, [], adapter, context, file, issues);
        extractResource(routes, file, final.node, final.part.args, routeContext, issues);
        continue;
      } else if (final && allowedRoot && routeMethods.has(final.part.name) && (adapter !== "codeigniter-4" || codeIgniter4Methods.has(final.part.name))) {
        const parts = methodList(final.part.name, final.part.args, adapter);
        const methods = parts.methods;
        if (methods) {
          const routeContext = routeOptions(chain.calls, [], adapter, context, file, issues);
          addRoute(routes, file, adapter, final.node, parts.pathArgument, methods, parts.targetArgument, routeContext);
        } else issues.push({ code: "unsupported-route-method-list", source: sourceRef(file, expression) });
        continue;
      } else if (final && allowedRoot && (unsupportedRouteForms.has(final.part.name) || !routeChainMethods.has(final.part.name))) {
        issues.push({ code: "unsupported-route-form", source: sourceRef(file, expression) });
        continue;
      } else if (!final && allowedRoot && isAst(expression.what) && (expression.what.kind === "staticlookup" || expression.what.kind === "propertylookup")) {
        issues.push({ code: "dynamic-route-declaration", source: sourceRef(file, expression) });
        continue;
      }
    }
    for (const value of Object.values(child)) {
      if (value === child.loc || value === child.errors) continue;
      if (isAst(value)) collectStatements(value, file, adapter, context, routes, issues, depth + 1, budget);
      else if (Array.isArray(value)) for (const item of value) if (isAst(item)) collectStatements(item, file, adapter, context, routes, issues, depth + 1, budget);
    }
  }
}

function signatureMatches(file: PhpParsedFile, id: RouteAdapterId): boolean {
  if (!file.ast) return false;
  if (id === "codeigniter-3") return ci3Routes(file, []).length > 0;
  const pending: unknown[] = [file.ast];
  let visited = 0;
  while (pending.length && visited++ < 100_000) {
    const current = pending.pop();
    if (!isAst(current)) continue;
    const part = callPart(current);
    const chain = callChain(current);
    if (part && routeRootMatches(chain.root, file, id, ["routes"]) && (part.name === "group" || !routeChainMethods.has(part.name))) return true;
    if (!part && routeRootMatches(chain.root, file, id, ["routes"]) && isAst(current.what) &&
      (current.what.kind === "staticlookup" || current.what.kind === "propertylookup")) return true;
    for (const value of Object.values(current)) {
      if (value === current.loc || value === current.errors) continue;
      if (isAst(value)) pending.push(value);
      else if (Array.isArray(value)) pending.push(...value);
    }
  }
  return false;
}

function summaryFor(id: RouteAdapterId, relevantFiles: readonly PhpParsedFile[], routes: CandidateRoute[], issues: InternalResult["issues"]): PhpAdapterSummary {
  const config = routeAdapters.find(adapter => adapter.id === id)!;
  const structural = relevantFiles.some(file => signatureMatches(file, id));
  const completeStructure = relevantFiles.some(file => file.status === "complete" && signatureMatches(file, id));
  const canonical = relevantFiles.some(file => config.canonicalPaths.includes(file.path));
  const detection: PhpDetectionConfidence = completeStructure && canonical ? "confirmed" : structural || canonical ? "probable" : "unknown";
  const selectedRoutes = routes.filter(route => route.adapter === id);
  const relevantParseIssues = relevantFiles.some(file => file.status !== "complete");
  const partial = relevantParseIssues || issues.some(issue => relevantFiles.some(file => issue.source?.path === file.path)) ||
    selectedRoutes.some(route => route.resolution === "dynamic" || route.resolution === "ambiguous" || route.resolution === "unresolved");
  return {
    adapter: id,
    detection,
    status: detection === "unknown" ? "not-detected" : partial ? "partial" : "analyzed",
    staticRoutes: selectedRoutes.filter(route => route.path !== undefined && route.methods.length > 0).length,
    dynamicRoutes: selectedRoutes.filter(route => route.resolution === "dynamic").length,
    ambiguousRoutes: selectedRoutes.filter(route => route.resolution === "ambiguous").length,
    unresolvedRoutes: selectedRoutes.filter(route => route.resolution === "unresolved").length,
  };
}

function frameworkAnalysis(id: RouteAdapterId, parsedFiles: readonly PhpParsedFile[], symbols: readonly PhpSymbol[]): InternalResult {
  const routes: CandidateRoute[] = [];
  const issues: InternalResult["issues"] = [];
  const config = routeAdapters.find(adapter => adapter.id === id)!;
  const candidateFiles = parsedFiles.filter(file => config.canonicalPaths.includes(file.path) || signatureMatches(file, id));
  for (const file of candidateFiles) {
    if (!file.ast || file.status !== "complete") {
      issues.push({ code: "php-parse-incomplete", source: { path: file.path, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 } });
      continue;
    }
    if (id === "codeigniter-3") routes.push(...ci3Routes(file, issues));
    else collectStatements(file.ast, file, id, { prefix: "", middleware: [], dynamicPrefix: false, routeVariables: ["routes"] }, routes, issues);
  }
  const resolved = routes.map(route => {
    if (!route.controller || !route.action || route.resolution === "dynamic") return route;
    const sourceFile = parsedFiles.find(file => file.path === route.source.path);
    return sourceFile ? resolveRoute(route, sourceFile, symbols) : route;
  });
  const summary = summaryFor(id, candidateFiles, resolved, issues);
  return { routes: resolved, summary, issues };
}

function publicRoute(route: CandidateRoute): PhpRouteEvidence {
  return {
    adapter: route.adapter,
    ...(route.path ? { path: route.path } : {}),
    methods: route.methods,
    ...(route.target && route.target.length <= 300 ? { target: route.target } : {}),
    middleware: route.middleware,
    source: route.source,
    certainty: route.certainty,
    resolution: route.resolution,
    ...(route.resolvedMethod ? { resolvedMethod: route.resolvedMethod } : {}),
    ...(route.parameterBindings ? { parameterBindings: route.parameterBindings } : {}),
  };
}

class PhpAstRouteAdapter implements PhpFrameworkAdapter {
  constructor(readonly id: RouteAdapterId) {}

  detect(context: PhpAdapterContext): { detection: PhpDetectionConfidence } {
    const result = frameworkAnalysis(this.id, context.files, context.symbols);
    return { detection: result.summary.detection };
  }

  analyze(context: PhpAdapterContext): PhpAdapterResult {
    const result = frameworkAnalysis(this.id, context.files, context.symbols);
    return { ...result.summary, routes: result.routes.map(publicRoute), issues: result.issues };
  }
}

export const PHP_ROUTE_ADAPTERS: readonly PhpFrameworkAdapter[] = routeAdapters.map(adapter => new PhpAstRouteAdapter(adapter.id));

export function analyzePhpRouting(context: PhpAdapterContext): { routes: PhpRouteEvidence[]; adapters: PhpAdapterSummary[]; issues: InternalResult["issues"] } {
  const results = PHP_ROUTE_ADAPTERS.map(adapter => adapter.analyze(context));
  return {
    routes: results.flatMap(result => result.routes),
    adapters: results.map(({ adapter, detection, status, staticRoutes, dynamicRoutes, ambiguousRoutes, unresolvedRoutes }) => ({
      adapter,
      detection,
      status,
      staticRoutes,
      dynamicRoutes,
      ambiguousRoutes,
      unresolvedRoutes,
    })),
    issues: results.flatMap(result => result.issues),
  };
}

export function phpAdapterResults(context: PhpAdapterContext): PhpAdapterResult[] {
  return PHP_ROUTE_ADAPTERS.map(adapter => adapter.analyze(context));
}

export function phpRouteGraphTarget(route: PhpRouteEvidence): string | undefined {
  return route.resolution === "resolved" ? route.resolvedMethod : undefined;
}
