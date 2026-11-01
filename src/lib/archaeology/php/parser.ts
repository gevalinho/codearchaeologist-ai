import phpParserModule from "php-parser";
import type { Engine as PhpParserInstance, Program } from "php-parser";

export type PhpPosition = { line: number; column: number };
export type PhpSourceRef = { path: string; startLine: number; endLine: number; startColumn: number; endColumn: number };
export type PhpSymbolKind = "namespace" | "import" | "class" | "interface" | "trait" | "enum" | "function" | "method";
export type PhpSymbol = {
  kind: PhpSymbolKind;
  name: string;
  namespace?: string;
  owner?: string;
  importType?: "class" | "function" | "const";
  alias?: string;
  source: PhpSourceRef;
};
export type PhpParseIssueCode = "source-limit" | "ast-node-limit" | "ast-depth-limit" | "syntax-error" | "parse-failed";
export type PhpParseIssue = { code: PhpParseIssueCode; line?: number };
export type PhpParseStatus = "complete" | "partial" | "unsupported";
export type PhpParsedFile = {
  path: string;
  status: PhpParseStatus;
  phpVersion: string;
  ast?: Program;
  symbols: PhpSymbol[];
  issues: PhpParseIssue[];
  astNodeCount: number;
};
export type PhpParserOptions = {
  phpVersion?: string;
  maxSourceBytes?: number;
  maxAstNodes?: number;
  maxAstDepth?: number;
};

export const DEFAULT_PHP_PARSER_OPTIONS = {
  phpVersion: "8.3",
  maxSourceBytes: 2 * 1024 * 1024,
  maxAstNodes: 100_000,
  maxAstDepth: 256,
} as const;

type AstRecord = Record<string, unknown> & { kind: string };
type Visit = { node: AstRecord; namespace: string; owner?: string; depth: number };
type PhpParserConstructor = new (options: object) => PhpParserInstance;
const PhpParserEngine = phpParserModule as unknown as PhpParserConstructor;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAstNode(value: unknown): value is AstRecord {
  return isRecord(value) && typeof value.kind === "string";
}

function astChildren(node: AstRecord): AstRecord[] {
  const children: AstRecord[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "leadingComments", "trailingComments", "errors", "tokens", "comments"].includes(key)) continue;
    if (isAstNode(value)) children.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (isAstNode(item)) children.push(item);
    }
  }
  return children;
}

function nameOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.name === "string") return value.name;
  return undefined;
}

function sourceOf(path: string, node: AstRecord): PhpSourceRef {
  const loc = isRecord(node.loc) ? node.loc : {};
  const start = isRecord(loc.start) ? loc.start : {};
  const end = isRecord(loc.end) ? loc.end : {};
  const startLine = Number.isSafeInteger(start.line) && (start.line as number) > 0 ? start.line as number : 1;
  const endLine = Number.isSafeInteger(end.line) && (end.line as number) >= startLine ? end.line as number : startLine;
  const startColumn = Number.isSafeInteger(start.column) && (start.column as number) >= 0 ? start.column as number : 0;
  const endColumn = Number.isSafeInteger(end.column) && (end.column as number) >= 0 ? end.column as number : startColumn;
  return { path, startLine, endLine, startColumn, endColumn };
}

function normalizedName(name: string | undefined): string | undefined {
  return name?.replace(/^\\+|\\+$/g, "").trim() || undefined;
}

function phpVersionNumber(version: string): number | undefined {
  const match = /^(5|7|8)\.(\d{1,2})$/.exec(version);
  if (!match) return undefined;
  const minor = Number(match[2]);
  if (Number(match[1]) === 5 && minor > 6) return undefined;
  if (Number(match[1]) === 7 && minor > 4) return undefined;
  if (Number(match[1]) === 8 && minor > 4) return undefined;
  return Number(match[1]) * 100 + minor;
}

function indexedSymbols(root: Program, path: string, maxNodes: number, maxDepth: number): { symbols: PhpSymbol[]; nodeCount: number; issue?: PhpParseIssue } {
  const first = root as unknown as AstRecord;
  const pending: Visit[] = [{ node: first, namespace: "", depth: 0 }];
  const visited = new WeakSet<object>();
  const symbols: PhpSymbol[] = [];
  let count = 0;

  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    if (current.depth > maxDepth) return { symbols: [], nodeCount: count, issue: { code: "ast-depth-limit" } };
    if (++count > maxNodes) return { symbols: [], nodeCount: count, issue: { code: "ast-node-limit" } };

    const { node } = current;
    const nodeNamespace = node.kind === "namespace"
      ? normalizedName(nameOf(node.name)) ?? ""
      : current.namespace;
    const source = sourceOf(path, node);
    const name = nameOf(node.name);
    const qualified = (value: string) => nodeNamespace ? `${nodeNamespace}\\${value}` : value;

    if (node.kind === "namespace") {
      symbols.push({ kind: "namespace", name: nodeNamespace, source });
    } else if (node.kind === "usegroup") {
      const prefix = normalizedName(nameOf(node.name));
      const items = Array.isArray(node.items) ? node.items.filter(isAstNode) : [];
      for (const item of items) {
        const importedName = normalizedName(nameOf(item.name));
        if (!importedName) continue;
        const fullName = prefix ? `${prefix}\\${importedName}` : importedName;
        symbols.push({
          kind: "import",
          name: fullName,
          namespace: nodeNamespace || undefined,
          importType: node.type === "function" ? "function" : node.type === "const" ? "const" : "class",
          alias: nameOf(item.alias),
          source: sourceOf(path, item),
        });
      }
    } else if (node.kind === "class" || node.kind === "interface" || node.kind === "trait" || node.kind === "enum") {
      if (name && node.isAnonymous !== true) {
        symbols.push({ kind: node.kind, name: qualified(name), namespace: nodeNamespace || undefined, source });
      }
    } else if (node.kind === "function" && name) {
      symbols.push({ kind: "function", name: qualified(name), namespace: nodeNamespace || undefined, source });
    } else if (node.kind === "method" && name) {
      symbols.push({ kind: "method", name, namespace: nodeNamespace || undefined, owner: current.owner, source });
    }

    const owner = ["class", "interface", "trait", "enum"].includes(node.kind) && name && node.isAnonymous !== true
      ? qualified(name)
      : current.owner;
    for (const child of astChildren(node)) {
      pending.push({ node: child, namespace: nodeNamespace, owner, depth: current.depth + 1 });
    }
  }
  return { symbols, nodeCount: count };
}

function syntaxIssues(ast: Program): PhpParseIssue[] {
  const errors = Array.isArray(ast.errors) ? ast.errors : [];
  const issues: PhpParseIssue[] = errors.slice(0, 20).map(error => {
    const line = Number.isSafeInteger(error.line) && error.line > 0 ? error.line : undefined;
    return line ? { code: "syntax-error", line } : { code: "syntax-error" };
  });
  if (errors.length > issues.length) issues.push({ code: "syntax-error" });
  return issues;
}

export function parsePhpSource(path: string, content: string, options: PhpParserOptions = {}): PhpParsedFile {
  const phpVersion = options.phpVersion ?? DEFAULT_PHP_PARSER_OPTIONS.phpVersion;
  const version = phpVersionNumber(phpVersion);
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_PHP_PARSER_OPTIONS.maxSourceBytes;
  const maxAstNodes = options.maxAstNodes ?? DEFAULT_PHP_PARSER_OPTIONS.maxAstNodes;
  const maxAstDepth = options.maxAstDepth ?? DEFAULT_PHP_PARSER_OPTIONS.maxAstDepth;
  if (!version || !Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 ||
    !Number.isSafeInteger(maxAstNodes) || maxAstNodes < 0 ||
    !Number.isSafeInteger(maxAstDepth) || maxAstDepth < 0) {
    return { path, status: "unsupported", phpVersion, symbols: [], issues: [{ code: "parse-failed" }], astNodeCount: 0 };
  }
  if (new TextEncoder().encode(content).byteLength > maxSourceBytes) {
    return { path, status: "unsupported", phpVersion, symbols: [], issues: [{ code: "source-limit" }], astNodeCount: 0 };
  }
  if (maxAstNodes === 0) {
    return { path, status: "partial", phpVersion, symbols: [], issues: [{ code: "ast-node-limit" }], astNodeCount: 0 };
  }

  try {
    const parser = new PhpParserEngine({
      parser: { version, suppressErrors: true },
      ast: { withPositions: true },
    });
    const ast = parser.parseCode(content, path);
    const issues = syntaxIssues(ast);
    const indexed = indexedSymbols(ast, path, maxAstNodes, maxAstDepth);
    if (indexed.issue) issues.push(indexed.issue);
    return {
      path,
      status: issues.length ? "partial" : "complete",
      phpVersion,
      ast,
      symbols: indexed.issue ? [] : indexed.symbols,
      issues,
      astNodeCount: indexed.nodeCount,
    };
  } catch {
    return { path, status: "unsupported", phpVersion, symbols: [], issues: [{ code: "parse-failed" }], astNodeCount: 0 };
  }
}
