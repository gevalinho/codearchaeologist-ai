import type { Graph, Node, Edge, Domain, SourceRef, BusinessRuleEvidence, AdapterCapability, PhpRouteCapability } from "./scanner";
import { codeOnLine, rulePatterns, type RuleLexicalState } from "./rule-patterns";
import { analyzeJavaScriptSource, resolveAngularUploadWrappers, resolveJavaScriptRelationships, type JavaScriptAnalysis } from "./javascript-analysis";
import { DEFAULT_PHP_PARSER_OPTIONS, parsePhpSource, type PhpParsedFile } from "./php/parser";
import { analyzePhpRouting, phpRouteGraphTarget } from "./php/route-adapters";
import { addTypedPhpMethodCallEdges, correlateFrontendPhpCalls } from "./cross-stack";

export type ScannedSource = { path: string; content: string; bytes: number };
const hash = async (value: string) => [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const stable = (kind: string, name: string) => `${kind}:${name}`;
const domainOf = (name: string): Domain => {
  if (/patient|hospital|doctor|nurse|pharm|prescri|medical|diagnos|ward|appointment|lab(?:oratory)?/i.test(name)) return "healthcare-legacy";
  if (/student|school|teacher|tuition|subject|class|session|term|score|result|promotion|attendance|exam|grade/i.test(name)) return "school-management";
  if (/auth|user|login|account|setting|config|util|helper|dashboard|upload/i.test(name)) return "shared-infrastructure";
  return "unknown";
};
const source = (file: string, startLine: number, endLine = startLine): SourceRef => ({ path: file, startLine, endLine });
const cleanLine = (line: string) => line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
function closingLine(lines: string[], start: number): number {
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i++) {
    const plain = lines[i].replace(/(['"])(?:\\.|(?!\1).)*?\1/g, "''").replace(/\/\/.*$/, "");
    for (const char of plain) { if (char === "{") { depth++; opened = true; } else if (char === "}") depth--; }
    if (opened && depth <= 0) return i + 1;
  }
  return start + 1;
}

export async function graphFromSources(files: ScannedSource[], warnings: string[]): Promise<Graph> {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const nodes = new Map<string, Node>(); const edgeRecords = new Map<string, Omit<Edge, "id">>(); const rules: BusinessRuleEvidence[] = [];
  const analyses: JavaScriptAnalysis[] = [];
  const javascriptBudget = { remainingNodes: 500_000 };
  const fileIds = new Map<string, string>();
  const javascriptFiles = files.filter(file => /\.(?:js|jsx|ts|tsx)$/i.test(file.path));
  const phpFiles = files.filter(file => /\.php$/i.test(file.path));
  const phpResults: PhpParsedFile[] = [];
  let remainingPhpAstNodes = 250_000;
  function node(kind: Node["kind"], name: string, ref: SourceRef, certainty: Node["certainty"] = "observed", method = "deterministic-pattern-v1"): string {
    const id = stable(kind, name); const previous = nodes.get(id); if (!previous || (previous.certainty === "inferred" && certainty === "observed")) nodes.set(id, { id, kind, name, domain: domainOf(name), source: ref, certainty, method }); return id;
  }
  function edge(from: string, to: string, kind: string, ref: SourceRef, certainty: Edge["certainty"] = "observed", method = "deterministic-pattern-v1") {
    edgeRecords.set(JSON.stringify([from, to, kind, ref]), { from, to, kind, source: ref, certainty, method });
  }
  for (const file of files) {
    const lines = file.content.split(/\r?\n/); const fileId = node("file", file.path, source(file.path, 1, lines.length));
    fileIds.set(file.path, fileId);
    if (/\.(?:js|jsx|ts|tsx)$/i.test(file.path)) {
      const analysis = analyzeJavaScriptSource(file.path, file.content, fileId, node, edge, javascriptBudget);
      analyses.push(analysis);
      if (!analysis.supported) warnings.push(`JavaScript/TypeScript syntax or analysis limit not supported: ${file.path}`);
      if (analysis.partial) warnings.push(`JavaScript/TypeScript analysis is partial (${analysis.partialReason ?? "bounded traversal"}): ${file.path}`);
      const jsRuleState: RuleLexicalState = { blockComment: false };
      for (let index = 0; index < lines.length; index++) {
        const foundRules = rulePatterns(lines[index], fileId, source(file.path, index + 1), jsRuleState);
        if (rules.length < 1000) rules.push(...foundRules.slice(0, 1000 - rules.length));
      }
      continue;
    }
    if (/\.php$/i.test(file.path)) {
      const parsed = parsePhpSource(file.path, file.content, {
        maxAstNodes: Math.min(DEFAULT_PHP_PARSER_OPTIONS.maxAstNodes, remainingPhpAstNodes),
      });
      phpResults.push(parsed);
      remainingPhpAstNodes = Math.max(0, remainingPhpAstNodes - parsed.astNodeCount);
      if (parsed.status !== "complete") warnings.push(`PHP syntax or analysis limit not supported: ${file.path}`);
    }
    let classId: string | undefined; let currentMethod: { id: string; end: number } | undefined;
    const ruleState: RuleLexicalState = { blockComment: false }; const structureState: RuleLexicalState = { blockComment: false };
    for (let index = 0; index < lines.length; index++) {
      const lineNumber = index + 1, line = cleanLine(lines[index]), ref = source(file.path, lineNumber);
      const structure = codeOnLine(lines[index], structureState);
      const classMatch = structure.match(/\bclass\s+([A-Za-z_]\w*)\b/);
      if (classMatch) { classId = node("class", `${file.path}#${classMatch[1]}`, source(file.path, lineNumber, closingLine(lines, index))); edge(fileId, classId, "declares", ref); }
      const methodMatch = structure.match(/\b(public|protected|private)?\s*(?:static\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
      if (methodMatch && classId) { const id = node("method", `${file.path}#${methodMatch[2]}`, source(file.path, lineNumber, closingLine(lines, index))); edge(classId, id, "declares", ref); currentMethod = { id, end: closingLine(lines, index) }; }
      if (currentMethod && lineNumber > currentMethod.end) currentMethod = undefined;
      const owner = currentMethod?.id ?? classId ?? fileId;
      for (const match of structure.matchAll(/\$this->(get_model|put_model)->([A-Za-z_]\w*)\s*\(/g)) {
        const model = match[1] === "get_model" ? "Get_model" : "Put_model";
        const target = node("method", `application/models/${model}.php#${match[2]}`, ref, "inferred"); edge(owner, target, "calls-model-method", ref, "inferred");
      }
      for (const match of line.matchAll(/\b(?:from|join|into|update)\s+([A-Za-z_]\w*)\b/gi)) {
        const table = node("table", match[1], ref, "inferred"); edge(owner, table, "references-table", ref, "inferred");
      }
      for (const match of line.matchAll(/(?:getTbSize|getTb|insertSingleData|insertBatchData|updateData)\([^;]*?,\s*['"]([A-Za-z_]\w*)['"]\s*\)/g)) {
        const table = node("table", match[1], ref, "inferred"); edge(owner, table, "references-table", ref, "inferred");
      }
      if (/\b(?:if|elseif)\s*\(/.test(structure) && /(?:40|60|session|classto|classops|compare|score|\bca\b)/i.test(structure)) {
        const branch = node("branch", `${file.path}:${lineNumber}`, ref); edge(owner, branch, "guards", ref);
      }
      const foundRules = rulePatterns(lines[index], currentMethod?.id ?? classId ?? fileId, ref, ruleState);
      if (rules.length < 1000) rules.push(...foundRules.slice(0, 1000 - rules.length));
    }
  }
  for (const parsed of phpResults.filter(result => result.status === "complete")) {
    const fileId = fileIds.get(parsed.path);
    if (!fileId) continue;
    const classNodes = new Map<string, string>();
    for (const symbol of parsed.symbols.filter(item => ["class", "interface", "trait", "enum"].includes(item.kind))) {
      const classNode = stable("class", `${parsed.path}#${symbol.name.split("\\").at(-1)}`);
      if (!nodes.has(classNode)) {
        node("class", `${parsed.path}#${symbol.name.split("\\").at(-1)}`, source(parsed.path, symbol.source.startLine, symbol.source.endLine));
        edge(fileId, classNode, "declares", source(parsed.path, symbol.source.startLine, symbol.source.endLine));
      }
      classNodes.set(symbol.name, classNode);
    }
    for (const symbol of parsed.symbols) {
      const symbolRef = source(parsed.path, symbol.source.startLine, symbol.source.endLine);
      if (symbol.kind === "method" && symbol.owner) {
        const owner = classNodes.get(symbol.owner);
        const methodName = `${parsed.path}#${symbol.name}`;
        const methodId = stable("method", methodName);
        if (owner && !nodes.has(methodId)) {
          node("method", methodName, symbolRef);
          edge(owner, methodId, "declares", symbolRef);
        }
      } else if (symbol.kind === "function") {
        const functionName = `${parsed.path}#${symbol.name}`;
        const functionId = stable("function", functionName);
        if (!nodes.has(functionId)) {
          node("function", functionName, symbolRef);
          edge(fileId, functionId, "declares", symbolRef);
        }
      }
    }
  }
  const usablePhpResults = phpResults.filter(result => result.status === "complete");
  const phpRoutingAnalysis = phpFiles.length
    ? analyzePhpRouting({ files: phpResults, symbols: usablePhpResults.flatMap(result => result.symbols) })
    : undefined;
  const backendRoutes: ({ id: string } & PhpRouteCapability & { legacyDynamic: boolean })[] = [];
  for (const route of phpRoutingAnalysis?.routes ?? []) {
    const ref = source(route.source.path, route.source.startLine, route.source.endLine);
    const extractionMethod = route.adapter === "codeigniter-3" ? "codeigniter-routing-v1" : "php-routing-adapter-v1";
    const isLegacyRoute = route.adapter === "codeigniter-3" && route.source.path === "application/config/routes.php";
    const legacyName = isLegacyRoute && route.path
      ? `${route.source.path}#${route.path.replace(/^\/+/, "")}`
      : undefined;
    const prefix = `${route.source.path}#${route.source.startLine}:${route.source.startColumn} ${route.methods.join(",")} `;
    const label = route.path ?? "dynamic";
    const boundedName = `${prefix.slice(0, 420)}${label.slice(0, Math.max(0, 500 - Math.min(prefix.length, 420)))}`;
    const name = legacyName && legacyName.length <= 500 ? legacyName : boundedName;
    const routeId = node("route", name, ref, route.certainty, extractionMethod);
    const fileId = fileIds.get(route.source.path);
    if (fileId) edge(fileId, routeId, "declares-route", ref, route.certainty, extractionMethod);
    const target = phpRouteGraphTarget(route);
    if (target) {
      const targetId = stable("method", target);
      if (nodes.has(targetId)) edge(routeId, targetId, "routes-to", ref, route.certainty, extractionMethod);
    }
    backendRoutes.push({ ...route, id: routeId, source: ref, legacyDynamic: !route.path || /[:(){}]|\$/.test(route.path) });
  }
  resolveAngularUploadWrappers(analyses, node, edge);
  for (const diagnostic of analyses.flatMap(analysis => analysis.wrapperDiagnostics)) {
    warnings.push(`AngularJS HTTP wrapper ${diagnostic.reason} at ${diagnostic.ref.path}:${diagnostic.ref.startLine}.`);
  }
  resolveJavaScriptRelationships(analyses, fileIds, node, edge);
  const phpMethodCalls = addTypedPhpMethodCallEdges(
    usablePhpResults,
    usablePhpResults.flatMap(result => result.symbols),
    id => nodes.has(id),
    edge,
  );
  const crossStackResult = javascriptFiles.length && phpFiles.length
    ? correlateFrontendPhpCalls(
      analyses,
      backendRoutes,
      usablePhpResults,
      usablePhpResults.flatMap(result => result.symbols),
      id => nodes.has(id),
      edge,
    )
    : undefined;
  if (crossStackResult) warnings.push(...crossStackResult.dispatchDiagnostics);
  const crossStackAnalysis = crossStackResult
    ? { totalHttpCalls: crossStackResult.totalHttpCalls, omittedHttpCalls: crossStackResult.omittedHttpCalls, matches: crossStackResult.matches }
    : undefined;
  const javascriptCapabilities = javascriptFiles.length ? {
    parser: "babel" as const,
    analyzedFiles: analyses.filter(analysis => analysis.supported).length,
    unsupportedFiles: analyses.filter(analysis => !analysis.supported).length,
    routingAdapters: mergeAdapterCapabilities(analyses.flatMap(analysis => analysis.adapters)),
    uiRouterStates: analyses.flatMap(analysis => analysis.uiRouterStates).sort((a, b) =>
      a.source.path.localeCompare(b.source.path) || a.source.startLine - b.source.startLine || a.state.localeCompare(b.state)),
  } : undefined;
  const phpCapabilities = phpFiles.length ? {
    parser: "php-parser" as const,
    analyzedFiles: phpResults.filter(result => result.status === "complete").length,
    partialFiles: phpResults.filter(result => result.status === "partial").length,
    unsupportedFiles: phpResults.filter(result => result.status === "unsupported").length,
    indexedSymbols: phpResults.reduce((count, result) => count + result.symbols.length, 0),
  } : undefined;
  const hasCi3Manifest = phpFiles.some(file => file.path === "application/config/routes.php");
  const backendRouting: AdapterCapability[] = [{
    adapter: "CodeIgniter",
    status: !hasCi3Manifest ? "not-detected" : backendRoutes.some(route => route.legacyDynamic && route.source.path === "application/config/routes.php") ? "partial" : "analyzed",
    staticRoutes: backendRoutes.filter(route => route.source.path === "application/config/routes.php" && !route.legacyDynamic).length,
    dynamicRoutes: backendRoutes.filter(route => route.source.path === "application/config/routes.php" && route.legacyDynamic).length,
  }];
  const capabilities = {
    ...(javascriptCapabilities ? { javascriptTypescript: javascriptCapabilities } : {}),
    ...(phpCapabilities ? { php: phpCapabilities } : {}),
    ...(hasCi3Manifest ? { backendRouting } : {}),
    ...(phpRoutingAnalysis ? { phpRouting: {
      adapters: phpRoutingAnalysis.adapters,
      routes: phpRoutingAnalysis.routes.map(route => ({
        ...route,
        source: source(route.source.path, route.source.startLine, route.source.endLine),
      })),
    } } : {}),
    ...(crossStackAnalysis ? { crossStack: { ...crossStackAnalysis, phpMethodCalls } } : {}),
  };
  if (phpRoutingAnalysis) {
    for (const adapter of phpRoutingAnalysis.adapters) if (adapter.detection !== "unknown" && adapter.status === "partial") warnings.push(`PHP routing analysis is partial for ${adapter.adapter}.`);
  }
  const unsupportedAdapters = javascriptCapabilities?.routingAdapters.filter(adapter => adapter.status === "unsupported").map(adapter => adapter.adapter) ?? [];
  const partialAdapters = javascriptCapabilities?.routingAdapters.filter(adapter => adapter.status === "partial").map(adapter => adapter.adapter) ?? [];
  const dynamicImportCount = analyses.reduce((sum, analysis) => sum + analysis.dynamicImports, 0);
  const sortedNodes = [...nodes.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sortedEdges = (await Promise.all([...edgeRecords].map(async ([signature, record]) => ({ ...record, id: (await hash(signature)).slice(0, 20) })))).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { schemaVersion: "1.0.0", snapshotId: await hash(JSON.stringify(await Promise.all(files.map(async f => [f.path, await hash(f.content)])))), nodes: sortedNodes, edges: sortedEdges, rules, warnings: warnings.sort(), limitations: ["PHP source is parsed and symbols are indexed with a bounded AST walk; supported CodeIgniter 3/4 and Laravel route forms are analyzed as source declarations only, and the AST is never executed.", "PHP routing support is limited to static route arguments, supported group prefixes and middleware, and explicitly recognized Laravel resources; dynamic declarations, unsupported resources, aliases, and unresolved controller methods remain partial or unresolved.", "PHP parser AST node/depth limits apply to symbol indexing after parsing; source-size and file/scan limits do not guarantee protection from parser-time CPU or memory exhaustion. Use an externally bounded worker process for hostile repositories.", "Business-rule patterns cover only single-line conditions, assignments, and arithmetic; they do not prove runtime behavior or business intent.", ...(rules.length === 1000 ? ["Business-rule evidence reached the 1,000-finding display limit; further rules may be omitted."] : []), ...(javascriptFiles.length ? ["JavaScript/TypeScript extraction uses a syntax parser but does not execute code or resolve arbitrary dynamic imports, calls, or routing.", ...(unsupportedAdapters.length ? [`Unsupported routing adapters: ${unsupportedAdapters.join(", ")}.`] : []), ...(partialAdapters.length ? [`Partially analyzed routing adapters: ${partialAdapters.join(", ")}.`] : []), ...(analyses.some(analysis => !analysis.supported) ? ["Some JavaScript/TypeScript files could not be parsed within the analysis limits."] : []), ...(dynamicImportCount ? ["Dynamic imports are recorded only when their module path is a static string."] : [])] : []), ...(crossStackAnalysis ? ["Frontend-to-PHP route correlations are inferred from static paths and source declarations; they do not establish deployment wiring or runtime traffic.", "Only typed `$this->property->method()` PHP calls with a unique declared target are linked. Dynamic receivers, constructor-injected parameters, inherited methods, and service locators remain unsupported; no database writes or business outcomes are inferred."] : []), "Dynamic PHP calls, SQL assembly, and route aliases may be unresolved.", "Inferred model targets are call-site references until a matching declaration is observed.", "Domain labels indicate naming evidence, not usage or reachability."], scan: { fileCount: files.length, totalBytes }, ...(Object.keys(capabilities).length ? { analysisCapabilities: capabilities } : {}) };
}

function mergeAdapterCapabilities(items: AdapterCapability[]): AdapterCapability[] {
  const grouped = new Map<string, AdapterCapability[]>();
  for (const item of items) grouped.set(item.adapter, [...(grouped.get(item.adapter) ?? []), item]);
  return [...grouped].map(([adapter, values]): AdapterCapability => ({
    adapter,
    status: values.some(item => item.status === "unsupported") ? "unsupported"
      : values.some(item => item.status === "partial") ? "partial"
        : values.some(item => item.status === "analyzed") ? "analyzed" : "not-detected",
    staticRoutes: values.reduce((sum, item) => sum + item.staticRoutes, 0),
    dynamicRoutes: values.reduce((sum, item) => sum + item.dynamicRoutes, 0),
  })).sort((a, b) => a.adapter.localeCompare(b.adapter));
}
