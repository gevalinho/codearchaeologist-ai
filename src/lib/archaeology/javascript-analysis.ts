import { parse } from "@babel/parser";
import type { AdapterCapability, AngularUiRouterState, Edge, Node, SourceRef } from "./scanner";

type AstNode = { type: string; [key: string]: unknown };
type SymbolInfo = { id: string; name: string; kind: Node["kind"]; ref: SourceRef };
type PendingRoute = {
  adapter: "angularjs" | "react-router";
  id?: string;
  path?: string;
  target?: string;
  controller?: string;
  stateName?: string;
  templateUrl?: string;
  templateSource?: SourceRef;
  controllerSource?: SourceRef;
  ref: SourceRef;
};
type PendingImport = { specifier: string; ref: SourceRef; bindings: { imported: string; local: string }[] };
type PendingWrapperDefinition = { serviceName: string; methodName: string; urlArgumentIndex?: number; ref: SourceRef };
type PendingWrapperCall = { serviceName: string; methodName: string; arguments: (string | undefined)[]; ownerId: string; ref: SourceRef };
type WrapperDiagnostic = { ref: SourceRef; reason: "unresolved-wrapper" | "ambiguous-wrapper" | "unsupported-wrapper" };
export type JavaScriptAnalysis = {
  path: string;
  supported: boolean;
  partial: boolean;
  partialReason?: "ast-depth-limit" | "ast-node-limit";
  symbols: SymbolInfo[];
  routes: PendingRoute[];
  uiRouterStates: AngularUiRouterState[];
  imports: PendingImport[];
  endpoints: { id: string; path?: string; method?: string; ref: SourceRef; wrapperSource?: SourceRef }[];
  wrapperDefinitions: PendingWrapperDefinition[];
  wrapperCalls: PendingWrapperCall[];
  wrapperDiagnostics: WrapperDiagnostic[];
  adapters: AdapterCapability[];
  unsupportedFrameworks: string[];
  dynamicImports: number;
};
type AddNode = (kind: Node["kind"], name: string, ref: SourceRef, certainty?: Node["certainty"], method?: string) => string;
type AddEdge = (from: string, to: string, kind: string, ref: SourceRef, certainty?: Edge["certainty"], method?: string) => void;

const AST_NODE_LIMIT = 100_000;
const AST_DEPTH_LIMIT = 256;
const ROUTE_AST_NODE_LIMIT = 10_000;
const ROUTE_AST_DEPTH_LIMIT = 512;
export type JavaScriptAnalysisBudget = { remainingNodes: number };
const jsxPlugins = ["jsx", "typescript"] as const;
const unsupportedRouteFrameworks = new Map([
  ["vue-router", "Vue Router"],
  ["@angular/router", "Angular Router"],
  ["next/router", "Next.js Router"],
  ["next/navigation", "Next.js Router"],
  ["@tanstack/react-router", "TanStack Router"],
  ["svelte-routing", "Svelte Routing"],
  ["@remix-run/react", "Remix Router"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isNode(value: unknown): value is AstNode {
  return isRecord(value) && typeof value.type === "string";
}
function children(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "leadingComments", "trailingComments", "innerComments", "comments", "tokens", "extra"].includes(key)) continue;
    if (isNode(value)) result.push(value);
    else if (Array.isArray(value)) for (const child of value) if (isNode(child)) result.push(child);
  }
  return result;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function nodeName(node: AstNode | undefined): string | undefined {
  return node?.type === "Identifier" || node?.type === "JSXIdentifier" ? text(node.name) : undefined;
}
function literal(node: AstNode | undefined): string | undefined {
  return node?.type === "StringLiteral" || node?.type === "Literal" ? text(node.value) : undefined;
}
function memberName(node: AstNode | undefined): string | undefined {
  return node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression"
    ? node.computed ? literal(isNode(node.property) ? node.property : undefined) : nodeName(isNode(node.property) ? node.property : undefined)
    : undefined;
}
function location(node: AstNode, file: string): SourceRef {
  const loc = isRecord(node.loc) ? node.loc : {};
  const start = isRecord(loc.start) ? loc.start : {};
  const end = isRecord(loc.end) ? loc.end : {};
  const startLine = Number.isSafeInteger(start.line) ? start.line as number : 1;
  const endLine = Number.isSafeInteger(end.line) ? end.line as number : startLine;
  return { path: file, startLine, endLine: Math.max(startLine, endLine) };
}
function callName(node: AstNode): string | undefined {
  const callee = isNode(node.callee) ? node.callee : undefined;
  return callee?.type === "Identifier" ? nodeName(callee) : memberName(callee);
}
function callObject(node: AstNode): string | undefined {
  const callee = isNode(node.callee) ? node.callee : undefined;
  const object = callee && isNode(callee.object) ? callee.object : undefined;
  return nodeName(object);
}
function propertyName(node: AstNode): string | undefined {
  return node.type === "ObjectProperty" || node.type === "ObjectMethod"
    ? node.computed ? literal(isNode(node.key) ? node.key : undefined) : nodeName(isNode(node.key) ? node.key : undefined)
    : undefined;
}
function objectProperties(node: AstNode | undefined): Map<string, AstNode> {
  const result = new Map<string, AstNode>();
  if (node?.type !== "ObjectExpression" || !Array.isArray(node.properties)) return result;
  for (const value of node.properties) if (isNode(value)) {
    const key = propertyName(value), item = isNode(value.value) ? value.value : undefined;
    if (key && item) result.set(key, item);
  }
  return result;
}
function staticHttpMethod(name: string | undefined, args: AstNode[], isFetch: boolean): string | undefined {
  const normalize = (value: string | undefined) => value && /^[A-Za-z]{1,16}$/.test(value) ? value.toUpperCase() : undefined;
  if (name && ["get", "post", "put", "patch", "delete"].includes(name.toLowerCase())) return name.toUpperCase();
  const options = isFetch ? args[1] : args[0];
  if (!options) return isFetch ? "GET" : undefined;
  if (!isNode(options) || options.type !== "ObjectExpression" || !Array.isArray(options.properties) ||
      options.properties.some(property => !isNode(property) || property.type === "SpreadElement")) return undefined;
  const properties = objectProperties(options);
  const method = properties.get("method");
  return method ? normalize(literal(method)) : isFetch ? "GET" : undefined;
}
function httpRequestConfig(name: string | undefined, args: AstNode[], isAngularConfig: boolean): { url?: string; method?: string } {
  if (!isAngularConfig && name !== "request") return {};
  const config = objectProperties(args[0]);
  const url = literal(config.get("url"));
  const method = literal(config.get("method"));
  return {
    ...(url !== undefined ? { url } : {}),
    ...(method && /^[A-Za-z]{1,16}$/.test(method) ? { method: method.toUpperCase() } : {}),
  };
}
function jsxName(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "JSXElement") {
    const opening = isNode(node.openingElement) ? node.openingElement : undefined;
    return opening && isNode(opening.name) ? nodeName(opening.name) : undefined;
  }
  if (node.type === "JSXExpressionContainer" && isNode(node.expression)) return jsxName(node.expression);
  return nodeName(node);
}
function safeEndpoint(value: string | undefined): value is string {
  return !!value && /^(?:\/|index\.php\/)[A-Za-z0-9_./{}:?=&-]+$/.test(value) && !value.startsWith("//") && !value.split(/[/?]/).includes("..");
}
function routeAdapter(adapter: string, status: AdapterCapability["status"] = "not-detected"): AdapterCapability {
  return { adapter, status, staticRoutes: 0, dynamicRoutes: 0 };
}
function withRouteCounts(adapter: AdapterCapability, routeId: PendingRoute["adapter"], routes: PendingRoute[]): AdapterCapability {
  const matched = routes.filter(route => route.adapter === routeId);
  const staticRoutes = matched.filter(route => route.path !== undefined).length;
  const dynamicRoutes = matched.length - staticRoutes;
  return { ...adapter, status: matched.length ? dynamicRoutes ? "partial" : "analyzed" : adapter.status, staticRoutes, dynamicRoutes };
}

type RouteAdapterContext = { path: string; nodes: AstNode[]; angularDetected: boolean; reactRouterDetected: boolean };
type FrontendRouteAdapter = {
  id: PendingRoute["adapter"];
  label: string;
  detected(context: RouteAdapterContext): boolean;
  extract(context: RouteAdapterContext): PendingRoute[];
};
const frontendRouteAdapters: FrontendRouteAdapter[] = [
  {
    id: "angularjs",
    label: "AngularJS",
    detected: context => context.angularDetected,
    extract: ({ path, nodes, angularDetected }) => {
      if (!angularDetected) return [];
      const routes: PendingRoute[] = [];
      for (const node of nodes) {
        if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") continue;
        if (!["when", "state"].includes(callName(node) ?? "")) continue;
        const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
        const config = objectProperties(args[1]);
        const controllerProperty = config.get("controller");
        const componentProperty = config.get("component");
        const target = literal(controllerProperty) ?? literal(componentProperty) ?? nodeName(componentProperty);
        const templateProperty = config.get("templateUrl");
        const stateName = callName(node) === "state" ? literal(args[0]) : undefined;
        const routePath = callName(node) === "state" ? literal(config.get("url")) : literal(args[0]);
        const templateUrl = literal(templateProperty);
        const reference = location(node, path);
        if (stateName || routePath !== undefined || config.size) routes.push({
          adapter: "angularjs",
          ...(routePath !== undefined ? { path: routePath } : {}),
          ...(stateName ? { stateName } : {}),
          ...(target ? { target } : {}),
          ...(literal(controllerProperty) ? { controller: literal(controllerProperty) } : {}),
          ...(templateUrl ? { templateUrl, templateSource: location(templateProperty!, path) } : {}),
          ...(literal(controllerProperty) && controllerProperty ? { controllerSource: location(controllerProperty, path) } : {}),
          ref: reference,
        });
        else if (args.length > 0) routes.push({ adapter: "angularjs", ref: reference });
      }
      return routes;
    },
  },
  {
    id: "react-router",
    label: "React Router",
    detected: context => context.reactRouterDetected,
    extract: ({ path, nodes, reactRouterDetected }) => {
      if (!reactRouterDetected) return [];
      const routes: PendingRoute[] = [];
      for (const node of nodes) {
        if (node.type === "JSXOpeningElement" && isNode(node.name) && nodeName(node.name) === "Route") {
          const attributes = Array.isArray(node.attributes) ? node.attributes.filter(isNode) : [];
          const pathAttribute = attributes.find(attribute => isNode(attribute.name) && nodeName(attribute.name) === "path");
          const value = pathAttribute && isNode(pathAttribute.value) ? pathAttribute.value : undefined;
          const routePath = value?.type === "StringLiteral" ? literal(value) : undefined;
          const element = attributes.find(attribute => isNode(attribute.name) && ["element", "Component"].includes(nodeName(attribute.name) ?? ""));
          const target = jsxName(element && isNode(element.value) ? element.value : undefined);
          routes.push({ adapter: "react-router", path: routePath, target, ref: location(node, path) });
        }
        if (node.type !== "CallExpression" || !["createBrowserRouter", "createHashRouter", "createMemoryRouter"].includes(callName(node) ?? "")) continue;
        const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
        const stack = args[0] ? [args[0]] : [];
        while (stack.length) {
          const route = stack.pop()!;
          if (route.type === "ObjectExpression") {
            const props = objectProperties(route);
            if (props.has("path")) {
              const routePath = literal(props.get("path"));
              const target = jsxName(props.get("element")) ?? nodeName(props.get("Component"));
              routes.push({ adapter: "react-router", path: routePath, target, ref: location(route, path) });
            }
          }
          stack.push(...children(route));
        }
      }
      return routes;
    },
  },
];

type AstCollection = { nodes: AstNode[]; parents: WeakMap<object, AstNode>; partialReason?: "ast-depth-limit" | "ast-node-limit" };

function collectAstNodes(root: AstNode, maxNodes: number, maxDepth: number, budget?: JavaScriptAnalysisBudget): AstCollection {
  const nodes: AstNode[] = [];
  const parents = new WeakMap<object, AstNode>();
  const pending: { node: AstNode; depth: number }[] = [{ node: root, depth: 0 }];
  let partialReason: AstCollection["partialReason"];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > maxDepth) {
      partialReason ??= "ast-depth-limit";
      continue;
    }
    if (nodes.length >= maxNodes || (budget && budget.remainingNodes <= 0)) {
      partialReason = "ast-node-limit";
      break;
    }
    nodes.push(current.node);
    if (budget) budget.remainingNodes--;
    for (const child of children(current.node)) {
      parents.set(child, current.node);
      pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  return { nodes, parents, ...(partialReason ? { partialReason } : {}) };
}

function callbackFromRegistration(value: AstNode | undefined): AstNode | undefined {
  if (!value) return undefined;
  if (value.type !== "ArrayExpression") return value;
  return Array.isArray(value.elements) ? value.elements.filter(isNode).at(-1) : undefined;
}

function registrationDependencies(value: AstNode | undefined): string[] {
  if (value?.type !== "ArrayExpression" || !Array.isArray(value.elements)) return [];
  return value.elements.flatMap(item => isNode(item) ? literal(item) ?? [] : []);
}

function callbackParameterNames(callback: AstNode | undefined): string[] {
  if (!callback || !Array.isArray(callback.params)) return [];
  return callback.params.flatMap(item => isNode(item) && item.type === "Identifier" ? nodeName(item) ?? [] : []);
}

function hasAngularDependency(dependencies: string[], parameters: string[]): boolean {
  const names = [...dependencies, ...parameters];
  return names.some(name => name.startsWith("$") || ["Upload", "$resource", "$http", "$scope", "$timeout"].includes(name));
}

function angularRegistration(node: AstNode, args: AstNode[]): boolean {
  const name = callName(node);
  if (!["controller", "service", "factory"].includes(name ?? "") || !literal(args[0]) || !callObject(node)) return false;
  const registration = callbackFromRegistration(args[1]);
  return hasAngularDependency(registrationDependencies(args[1]), callbackParameterNames(registration));
}

function angularRouteHint(node: AstNode): boolean {
  if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return false;
  const name = callName(node), receiver = callObject(node);
  if ((name === "state" && receiver === "$stateProvider") || (name === "when" && receiver === "$routeProvider")) return true;
  if (name !== "config") return false;
  const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
  const callback = callbackFromRegistration(args[0]);
  return callbackParameterNames(callback).some(parameter => parameter === "$stateProvider" || parameter === "$routeProvider");
}

function containsAngularHint(root: AstNode): boolean {
  const pending: { node: AstNode; depth: number }[] = [{ node: root, depth: 0 }];
  let visited = 0;
  while (pending.length && visited++ < 2_000) {
    const current = pending.shift()!;
    if (current.depth > 64) continue;
    const node = current.node;
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
        ((callName(node) === "module" && callObject(node) === "angular") || angularRouteHint(node) ||
          angularRegistration(node, Array.isArray(node.arguments) ? node.arguments.filter(isNode) : []))) return true;
    pending.push(...children(node).map(child => ({ node: child, depth: current.depth + 1 })));
  }
  return false;
}

function isUiRouteTemplate(value: string | undefined): value is string {
  return !!value && value.length <= 500 && /^[A-Za-z0-9_./-]+$/.test(value) && !value.split("/").includes("..");
}

function wrapperDefinition(path: string, serviceName: string, registration: AstNode): PendingWrapperDefinition[] {
  const args = Array.isArray(registration.arguments) ? registration.arguments.filter(isNode) : [];
  const callback = callbackFromRegistration(args[1]);
  if (!callback || !isNode(callback.body)) return [];
  const dependencies = registrationDependencies(args[1]);
  const callbackParameters = callbackParameterNames(callback);
  const uploadIndex = callbackParameters.findIndex((parameter, index) => parameter === "Upload" && dependencies[index] === "Upload");
  if (uploadIndex < 0 || !Array.isArray(callback.body.body)) return [];
  const definitions: PendingWrapperDefinition[] = [];
  const pending: AstNode[] = [...callback.body.body].filter(isNode);
  let visited = 0;
  while (pending.length && visited++ < 10_000) {
    const current = pending.pop()!;
    if (current.type === "AssignmentExpression" && isNode(current.left) && current.left.type === "MemberExpression" &&
        isNode(current.left.object) && current.left.object.type === "ThisExpression" && isNode(current.left.property)) {
      const methodName = nodeName(current.left.property);
      const method = isNode(current.right) ? current.right : undefined;
      if (methodName && method && ["FunctionExpression", "ArrowFunctionExpression"].includes(method.type)) {
        const parameters = Array.isArray(method.params) ? method.params.filter(isNode).map(nodeName) : [];
        const methodBody = isNode(method.body) && method.body.type === "BlockStatement" ? method.body.body : undefined;
        const statements = Array.isArray(methodBody) ? methodBody.filter(isNode) : [];
        let urlArgumentIndex: number | undefined;
        if (parameters.length && statements.length === 1 && statements[0].type === "ReturnStatement" &&
            isNode(statements[0].argument) && (statements[0].argument.type === "CallExpression" || statements[0].argument.type === "OptionalCallExpression") &&
            callName(statements[0].argument) === "upload" && callObject(statements[0].argument) === callbackParameters[uploadIndex]) {
          const uploadArgs = Array.isArray(statements[0].argument.arguments) ? statements[0].argument.arguments.filter(isNode) : [];
          const configNode = uploadArgs[0];
          const config = objectProperties(configNode);
          const url = config.get("url");
          const data = config.get("data");
          const urlName = url?.type === "Identifier" ? nodeName(url) : undefined;
          const hasObjectConfig = configNode?.type === "ObjectExpression" && Array.isArray(configNode.properties);
          const rawProperties = isNode(configNode) && configNode.type === "ObjectExpression" && Array.isArray(configNode.properties)
            ? configNode.properties
            : [];
          const properties = rawProperties.filter(isNode);
          const staticConfig = hasObjectConfig && properties.length === rawProperties.length &&
            properties.every(property => property.type === "ObjectProperty" && !property.computed) &&
            new Set(properties.map(propertyName).filter(Boolean)).size === properties.length &&
            properties.every(property => propertyName(property) === "url" || propertyName(property) === "data");
          if (urlName && data && staticConfig && parameters.filter(parameter => parameter === urlName).length === 1) {
            urlArgumentIndex = parameters.indexOf(urlName);
          }
        }
        definitions.push({ serviceName, methodName, ...(urlArgumentIndex !== undefined ? { urlArgumentIndex } : {}), ref: location(method, path) });
      }
    }
    pending.push(...children(current));
  }
  return definitions;
}

export function analyzeJavaScriptSource(path: string, content: string, fileId: string, addNode: AddNode, addEdge: AddEdge, budget: JavaScriptAnalysisBudget): JavaScriptAnalysis {
  let ast: AstNode;
  try {
    const parsed = parse(content, { sourceType: "unambiguous", plugins: [...jsxPlugins], errorRecovery: false });
    ast = parsed.program as unknown as AstNode;
  } catch {
    return {
      path, supported: false, partial: false, symbols: [], routes: [], uiRouterStates: [], imports: [], endpoints: [],
      wrapperDefinitions: [], wrapperCalls: [], wrapperDiagnostics: [],
      adapters: frontendRouteAdapters.map(adapter => routeAdapter(adapter.label)), unsupportedFrameworks: [], dynamicImports: 0,
    };
  }
  const collection = collectAstNodes(ast, AST_NODE_LIMIT, AST_DEPTH_LIMIT, budget);
  const { nodes, parents } = collection;

  const symbols: SymbolInfo[] = [], routes: PendingRoute[] = [], imports: PendingImport[] = [], endpoints: JavaScriptAnalysis["endpoints"] = [];
  const wrapperDefinitions: PendingWrapperDefinition[] = [], wrapperCalls: PendingWrapperCall[] = [], wrapperDiagnostics: WrapperDiagnostic[] = [];
  const declarations = new WeakMap<object, string>();
  const registrationOwners = new WeakMap<object, string>();
  const axiosLocals = new Set(["axios"]);
  const unsupportedFrameworks = new Set<string>();
  let angularDetected = false, reactRouterDetected = false, dynamicImports = 0;
  const frameworkNames = new Map<string, string>();
  for (const node of nodes) {
    if (node.type === "ImportDeclaration" && isNode(node.source)) {
      const imported = literal(node.source);
      if (imported === "react-router" || imported === "react-router-dom") reactRouterDetected = true;
      const framework = imported ? unsupportedRouteFrameworks.get(imported) : undefined;
      if (imported && framework) frameworkNames.set(imported, framework);
      if (imported === "axios" && Array.isArray(node.specifiers)) {
        for (const specifier of node.specifiers) {
          if (isNode(specifier) && (specifier.type === "ImportDefaultSpecifier" || specifier.type === "ImportNamespaceSpecifier") && isNode(specifier.local)) {
            const local = nodeName(specifier.local);
            if (local) axiosLocals.add(local);
          }
        }
      }
    }
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") && callName(node) === "module" && callObject(node) === "angular") angularDetected = true;
    if (angularRouteHint(node)) angularDetected = true;
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
        angularRegistration(node, Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [])) angularDetected = true;
  }
  const routeCandidate = angularDetected || containsAngularHint(ast);
  const routeCollection = routeCandidate
    ? collectAstNodes(ast, ROUTE_AST_NODE_LIMIT, ROUTE_AST_DEPTH_LIMIT, budget)
    : undefined;
  if (routeCollection) {
    for (const node of routeCollection.nodes) {
      if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
          callName(node) === "module" && callObject(node) === "angular") angularDetected = true;
      if (angularRouteHint(node)) angularDetected = true;
      if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
          angularRegistration(node, Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [])) angularDetected = true;
    }
  }
  const symbolByName = new Map<string, string>();
  const makeSymbol = (kind: Node["kind"], name: string, ref: SourceRef): string => {
    const id = addNode(kind, `${path}#${name}`, ref, "observed", "babel-ast-v1");
    symbols.push({ id, name, kind, ref });
    if (!symbolByName.has(name)) symbolByName.set(name, id);
    return id;
  };
  const containsJsx = (root: AstNode): boolean => {
    const stack = [root], visited = new Set<object>();
    while (stack.length) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current.type === "JSXElement" || current.type === "JSXFragment") return true;
      stack.push(...children(current));
    }
    return false;
  };

  for (const node of nodes) {
    if (node.type === "ImportDeclaration") {
      const source = isNode(node.source) ? literal(node.source) : undefined;
      if (!source) continue;
      const bindings = Array.isArray(node.specifiers) ? node.specifiers.flatMap(specifier => {
        if (!isNode(specifier) || !isNode(specifier.local)) return [];
        const local = nodeName(specifier.local);
        if (!local) return [];
        if (specifier.type === "ImportSpecifier") {
          const imported = isNode(specifier.imported) ? nodeName(specifier.imported) ?? literal(specifier.imported) : undefined;
          return imported ? [{ imported, local }] : [];
        }
        return [{ imported: specifier.type === "ImportDefaultSpecifier" ? "default" : "*", local }];
      }) : [];
      imports.push({ specifier: source, ref: location(node, path), bindings });
      if (source === "react-router" || source === "react-router-dom") reactRouterDetected = true;
      if (source === "axios") {
        const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
        for (const specifier of specifiers) if (isNode(specifier) && isNode(specifier.local)) axiosLocals.add(nodeName(specifier.local)!);
      }
      continue;
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      const name = isNode(node.id) ? nodeName(node.id) : undefined;
      if (name) {
        const id = makeSymbol("class", name, location(node, path));
        declarations.set(node, id);
        addEdge(fileId, id, "declares", location(node, path), "observed", "babel-ast-v1");
        const superClass = isNode(node.superClass) ? nodeName(node.superClass) : undefined;
        if (superClass === "Component" || superClass === "PureComponent" || containsJsx(node)) {
          const componentId = addNode("component", `${path}#${name}`, location(node, path), "observed", "babel-ast-v1");
          addEdge(fileId, componentId, "declares", location(node, path), "observed", "babel-ast-v1");
          symbols.push({ id: componentId, name, kind: "component", ref: location(node, path) });
          symbolByName.set(name, componentId);
        }
      }
      continue;
    }
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      let name = isNode(node.id) ? nodeName(node.id) : undefined;
      if (!name) {
        const parent = parents.get(node);
        if (parent?.type === "VariableDeclarator" && isNode(parent.id)) name = nodeName(parent.id);
        else if (parent?.type === "ObjectProperty") name = propertyName(parent);
      }
      if (name) {
        const body = isNode(node.body) ? node.body : undefined;
        const kind: Node["kind"] = /^[A-Z]/.test(name) && body && containsJsx(body) ? "component" : "function";
        const id = makeSymbol(kind, name, location(node, path));
        declarations.set(node, id);
        addEdge(fileId, id, "declares", location(node, path), "observed", "babel-ast-v1");
      }
      continue;
    }
    if (node.type === "ClassMethod" || node.type === "ClassPrivateMethod" || node.type === "ObjectMethod") {
      const name = propertyName(node);
      if (!name) continue;
      let parent = parents.get(node), owner: string | undefined;
      while (parent && !owner) {
        owner = declarations.get(parent);
        parent = parents.get(parent);
      }
      const id = makeSymbol("method", name, location(node, path));
      declarations.set(node, id);
      if (owner) addEdge(owner, id, "declares", location(node, path), "observed", "babel-ast-v1");
      continue;
    }
    if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") continue;
    const name = callName(node);
    const args = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
    const callRef = location(node, path);
    if (name === "module" && callObject(node) === "angular") {
      angularDetected = true;
      const moduleName = literal(args[0]);
      if (moduleName) {
        const id = addNode("angular-module", moduleName, callRef, "observed", "angularjs-adapter-v1");
        addEdge(fileId, id, "declares", callRef, "observed", "angularjs-adapter-v1");
      }
    }
    if (["controller", "service", "factory"].includes(name ?? "") && angularDetected && literal(args[0])) {
      const kind = name === "controller" ? "controller" : name as "service" | "factory";
      const registrationName = literal(args[0])!;
      const id = addNode(kind, `${path}#${registrationName}`, callRef, "observed", "angularjs-adapter-v1");
      symbols.push({ id, name: registrationName, kind, ref: callRef });
      addEdge(fileId, id, "registers", callRef, "observed", "angularjs-adapter-v1");
      if (isNode(args[1])) {
        const callback = args[1].type === "ArrayExpression" && Array.isArray(args[1].elements)
          ? args[1].elements.filter(isNode).at(-1)
          : args[1];
        if (callback) registrationOwners.set(callback, id);
      }
      if (kind === "service") wrapperDefinitions.push(...wrapperDefinition(path, registrationName, node));
    }
    const callee = isNode(node.callee) ? node.callee : undefined;
    const angularConfigCall = !!callee && callee.type === "Identifier" && nodeName(callee) === "$http";
    const isFetch = name === "fetch" && callee?.type === "Identifier";
    if (name === "postMultiForm" && callee && (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression")) {
      const serviceName = nodeName(isNode(callee.object) ? callee.object : undefined);
      if (serviceName) {
        const ownerId = (() => {
          let parent = parents.get(node);
          while (parent) {
            const registered = registrationOwners.get(parent) ?? declarations.get(parent);
            if (registered) return registered;
            parent = parents.get(parent);
          }
          return fileId;
        })();
        wrapperCalls.push({
          serviceName,
          methodName: name,
          arguments: args.map(literal),
          ownerId,
          ref: callRef,
        });
        continue;
      }
    }
    const isHttp = isFetch || angularConfigCall || !!name &&
      ["get", "post", "put", "patch", "delete", "request"].includes(name) &&
      (axiosLocals.has(callObject(node) ?? "") || callObject(node) === "$http");
    if (isHttp) {
      const requestConfig = httpRequestConfig(name, args, angularConfigCall);
      const url = requestConfig.url ?? literal(args[0]);
      const method = requestConfig.method ?? staticHttpMethod(name, args, isFetch);
      const ownerId = (() => {
        let parent = parents.get(node);
        while (parent) {
          const registered = registrationOwners.get(parent) ?? declarations.get(parent);
          if (registered) return registered;
          parent = parents.get(parent);
        }
        return fileId;
      })();
      if (safeEndpoint(url)) {
        const id = addNode("endpoint", url, callRef, "observed", "babel-ast-v1");
        addEdge(ownerId, id, "calls-endpoint", callRef, "observed", "babel-ast-v1");
        endpoints.push({ id, path: url, ...(method ? { method } : {}), ref: callRef });
      } else {
        const id = addNode("http-call", `dynamic HTTP request in ${path}:${callRef.startLine}`, callRef, "observed", "babel-ast-v1");
        addEdge(ownerId, id, "makes-http-call", callRef, "observed", "babel-ast-v1");
        endpoints.push({ id, ...(method ? { method } : {}), ref: callRef });
      }
    }
    if (callee?.type === "Import" || callee?.type === "ImportExpression") {
      dynamicImports++;
      const specifier = literal(args[0]);
      if (specifier) imports.push({ specifier, ref: callRef, bindings: [] });
    }
  }

  for (const node of nodes) {
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
      const declaration = isNode(node.declaration) ? node.declaration : undefined;
      const id = declaration && declarations.get(declaration);
      if (id) addEdge(fileId, id, "exports", location(node, path), "observed", "babel-ast-v1");
      const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
      for (const specifier of specifiers) if (isNode(specifier) && isNode(specifier.local)) {
        const local = nodeName(specifier.local), target = local ? symbolByName.get(local) : undefined;
        if (target) addEdge(fileId, target, "exports", location(specifier, path), "observed", "babel-ast-v1");
      }
    }
  }

  const routeNodes = angularDetected ? routeCollection?.nodes ?? nodes : nodes;
  const routeContext: RouteAdapterContext = { path, nodes: routeNodes, angularDetected, reactRouterDetected };
  for (const adapter of frontendRouteAdapters) if (adapter.detected(routeContext)) routes.push(...adapter.extract(routeContext));
  const uiRouterStates: AngularUiRouterState[] = routes.flatMap(route => {
    if (!route.stateName) return [];
    return [{
      state: route.stateName,
      ...(route.path ? { url: route.path } : {}),
      ...(isUiRouteTemplate(route.templateUrl) ? { templateUrl: route.templateUrl } : {}),
      ...(route.controller ? { controller: route.controller } : {}),
      source: route.ref,
      ...(route.templateSource ? { templateSource: route.templateSource } : {}),
      ...(route.controllerSource ? { controllerSource: route.controllerSource } : {}),
    }];
  });
  for (const imported of imports) {
    const moduleId = addNode("module", `${path}#${imported.specifier}`, imported.ref, "observed", "babel-ast-v1");
    addEdge(fileId, moduleId, imported.specifier.startsWith(".") ? "imports" : "depends-on", imported.ref, "observed", "babel-ast-v1");
  }
  for (const route of routes) if (route.path !== undefined || route.stateName) {
    const id = addNode("route", route.stateName ?? route.path!, route.ref, "observed", `${route.adapter}-routing-v1`);
    addEdge(fileId, id, "declares-route", route.ref, "observed", `${route.adapter}-routing-v1`);
    route.id = id;
  }
  for (const framework of frameworkNames.values()) unsupportedFrameworks.add(framework);
  const routePartial = angularDetected && !!routeCollection?.partialReason;
  const adapters = [
    ...frontendRouteAdapters.map(adapter => {
      const capability = withRouteCounts(routeAdapter(adapter.label, adapter.detected(routeContext) ? "partial" : "not-detected"), adapter.id, routes);
      return routePartial && adapter.id === "angularjs" && adapter.detected(routeContext)
        ? { ...capability, status: "partial" as const }
        : capability;
    }),
    ...[...unsupportedFrameworks].sort().map(name => routeAdapter(name, "unsupported")),
  ];
  const partialReason = collection.partialReason ?? (angularDetected ? routeCollection?.partialReason : undefined);
  return {
    path,
    supported: true,
    partial: !!partialReason,
    ...(partialReason ? { partialReason } : {}),
    symbols,
    routes,
    uiRouterStates,
    imports,
    endpoints,
    wrapperDefinitions,
    wrapperCalls,
    wrapperDiagnostics,
    adapters,
    unsupportedFrameworks: [...unsupportedFrameworks],
    dynamicImports,
  };
}

export function resolveAngularUploadWrappers(
  analyses: JavaScriptAnalysis[],
  addNode: AddNode,
  addEdge: AddEdge,
): void {
  const definitions = analyses.flatMap(analysis => analysis.wrapperDefinitions);
  for (const analysis of analyses) {
    for (const call of analysis.wrapperCalls) {
      const candidates = definitions.filter(definition =>
        definition.serviceName === call.serviceName && definition.methodName === call.methodName);
      if (candidates.length !== 1) {
        analysis.wrapperDiagnostics.push({
          ref: call.ref,
          reason: candidates.length > 1 ? "ambiguous-wrapper" : "unresolved-wrapper",
        });
        continue;
      }
      const wrapper = candidates[0];
      if (wrapper.urlArgumentIndex === undefined) {
        analysis.wrapperDiagnostics.push({ ref: call.ref, reason: "unsupported-wrapper" });
        continue;
      }
      const url = call.arguments[wrapper.urlArgumentIndex];
      const wrapperSource = wrapper.ref;
      if (!safeEndpoint(url)) {
        const id = addNode(
          "http-call",
          `dynamic HTTP request in ${analysis.path}:${call.ref.startLine}`,
          call.ref,
          "observed",
          "babel-angular-upload-wrapper-v1",
        );
        addEdge(call.ownerId, id, "makes-http-call", call.ref, "observed", "babel-angular-upload-wrapper-v1");
        analysis.endpoints.push({ id, ref: call.ref, wrapperSource });
        continue;
      }
      const id = addNode("endpoint", url, call.ref, "observed", "babel-angular-upload-wrapper-v1");
      addEdge(call.ownerId, id, "calls-endpoint", call.ref, "observed", "babel-angular-upload-wrapper-v1");
      analysis.endpoints.push({ id, path: url, ref: call.ref, wrapperSource });
    }
  }
}

export function resolveJavaScriptRelationships(
  analyses: JavaScriptAnalysis[],
  fileIds: ReadonlyMap<string, string>,
  addNode: AddNode,
  addEdge: AddEdge,
): void {
  const symbols = new Map<string, SymbolInfo[]>();
  for (const analysis of analyses) for (const symbol of analysis.symbols) symbols.set(symbol.name, [...(symbols.get(symbol.name) ?? []), symbol]);
  const resolveModulePath = (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const joined = (from.split("/").slice(0, -1).concat(specifier.split("/"))).reduce<string[]>((result, part) => {
      if (part === "." || !part) return result;
      if (part === "..") result.pop();
      else result.push(part);
      return result;
    }, []);
    const base = joined.join("/");
    const candidates = [base, ...[".js", ".jsx", ".ts", ".tsx"].map(extension => `${base}${extension}`), ...["index.js", "index.jsx", "index.ts", "index.tsx"].map(index => `${base}/${index}`)];
    return candidates.find(candidate => fileIds.has(candidate));
  };
  for (const analysis of analyses) {
    for (const imported of analysis.imports) {
      const resolvedPath = resolveModulePath(analysis.path, imported.specifier);
      const resolved = resolvedPath ? fileIds.get(resolvedPath) : undefined;
      if (resolved) {
        const moduleId = `module:${analysis.path}#${imported.specifier}`;
        addEdge(moduleId, resolved, "resolves-to", imported.ref, "observed", "babel-ast-v1");
      }
    }
    for (const route of analysis.routes) if (route.id && route.target) {
      const eligible = (symbol: SymbolInfo) => symbol.kind === "component" || symbol.kind === "controller";
      const localCandidates = (symbols.get(route.target) ?? []).filter(symbol => eligible(symbol) && symbol.ref.path === analysis.path);
      const importedCandidates = analysis.imports.flatMap(imported => {
        const resolvedPath = resolveModulePath(analysis.path, imported.specifier);
        if (!resolvedPath) return [];
        return imported.bindings.filter(binding => binding.local === route.target && binding.imported !== "default" && binding.imported !== "*")
          .flatMap(binding => (symbols.get(binding.imported) ?? []).filter(symbol => eligible(symbol) && symbol.ref.path === resolvedPath));
      });
      const globalAngularCandidates = route.adapter === "angularjs" ? (symbols.get(route.target) ?? []).filter(symbol => eligible(symbol)) : [];
      const candidates = localCandidates.length ? localCandidates : importedCandidates.length ? importedCandidates : globalAngularCandidates;
      const target = candidates.length === 1 ? candidates[0] : undefined;
      if (target) addEdge(route.id, target.id, "routes-to", route.ref, "observed", `${route.adapter}-routing-v1`);
      else if (route.target) {
        const label = route.adapter === "angularjs" ? "AngularJS" : "React Router";
        const capability = analysis.adapters.find(adapter => adapter.adapter === label);
        if (capability?.status === "analyzed") capability.status = "partial";
      }
    }
  }
}
