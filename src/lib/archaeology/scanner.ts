import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export type Domain = "school-management" | "healthcare-legacy" | "shared-infrastructure" | "unknown";
export type SourceRef = { path: string; startLine: number; endLine: number };
export type Node = { id: string; kind: "file" | "class" | "method" | "angular-module" | "controller" | "service" | "factory" | "table" | "endpoint" | "branch"; name: string; domain: Domain; source: SourceRef; certainty: "observed" | "inferred"; method: string };
export type Edge = { id: string; from: string; to: string; kind: string; source: SourceRef; certainty: "observed" | "inferred"; method: string };
export type Graph = { schemaVersion: "1.0.0"; snapshotId: string; nodes: Node[]; edges: Edge[]; warnings: string[]; limitations: string[]; scan: { fileCount: number; totalBytes: number } };
export type ScanLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
export const DEFAULT_SCAN_LIMITS: ScanLimits = { maxFiles: 300, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024 };
const excludedDirectories = new Set([".git", "node_modules", "vendor", "bower_components", "system", "user_guide", "third_party", "config", "cache", "caches", "logs", "uploads", "dist", "build", "coverage", "generated", "fonts", "img", "images", "css"]);
const sensitive = /(^\.|(?:^|[._-])(?:config|database|credentials?|secrets?|passwords?|keys?|token|backup|dump)(?:[._-]|$)|\.(?:sql|pem|key|p12|pfx|bak|log)$)/i;
const applicationScripts = new Set(["angular.main.js", "main.js", "module.js", "factories.js", "services.js", "routes.js", "directives.js", "runnables.js", "navrouter.js", "adminDir.js", "genexa.js"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
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
export async function scanRepository(configuredRoot: string | undefined, limits: ScanLimits = DEFAULT_SCAN_LIMITS): Promise<Graph> {
  if (!configuredRoot || !path.isAbsolute(configuredRoot) || configuredRoot.includes("\0") || configuredRoot.split(path.sep).includes("..")) throw new Error("An absolute configured repository root without traversal is required");
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error("Invalid scan limits");
  if ((await lstat(configuredRoot)).isSymbolicLink()) throw new Error("Repository root cannot be a symlink");
  const root = await realpath(configuredRoot);
  if (!(await lstat(root)).isDirectory()) throw new Error("Repository root must be a directory");
  const files: { path: string; content: string; bytes: number }[] = [];
  let totalBytes = 0;
  const warnings: string[] = [];
  async function walk(relative: string): Promise<void> {
    const entries = (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { warnings.push(`Skipped symlink: ${next}`); continue; }
      if (entry.name.startsWith(".") || excludedDirectories.has(entry.name.toLowerCase())) continue;
      if (entry.isDirectory()) { await walk(next); continue; }
      if (!entry.isFile() || sensitive.test(entry.name) || /(?:\.min|\.bundle)\.(?:js|php)$/i.test(entry.name) || !/\.(?:php|js)$/i.test(entry.name)) continue;
      if (!(next.startsWith("application/") || next.startsWith("assets/js/"))) continue;
      if (next.startsWith("assets/js/") && !applicationScripts.has(entry.name)) continue;
      if (files.length >= limits.maxFiles) throw new Error("File count limit exceeded");
      const absolute = path.join(root, next);
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.size > limits.maxFileBytes) throw new Error("File size limit exceeded");
      if (totalBytes + metadata.size > limits.maxTotalBytes) throw new Error("Total byte limit exceeded");
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { const opened = await handle.stat(); if (!opened.isFile() || opened.size !== metadata.size) throw new Error("Source changed during scan"); bytes = await handle.readFile(); } finally { await handle.close(); }
      if (bytes.length !== metadata.size || bytes.includes(0)) { warnings.push(`Skipped binary or changed source: ${next}`); continue; }
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { warnings.push(`Skipped invalid UTF-8 source: ${next}`); continue; }
      files.push({ path: next, content, bytes: bytes.length }); totalBytes += bytes.length;
    }
  }
  await walk("");
  const nodes = new Map<string, Node>(); const edges = new Map<string, Edge>();
  function node(kind: Node["kind"], name: string, ref: SourceRef, certainty: Node["certainty"] = "observed", method = "deterministic-pattern-v1"): string {
    const id = stable(kind, name); const previous = nodes.get(id); if (!previous || (previous.certainty === "inferred" && certainty === "observed")) nodes.set(id, { id, kind, name, domain: domainOf(name), source: ref, certainty, method }); return id;
  }
  function edge(from: string, to: string, kind: string, ref: SourceRef, certainty: Edge["certainty"] = "observed", method = "deterministic-pattern-v1") {
    const id = hash(JSON.stringify([from, to, kind, ref])).slice(0, 20); edges.set(id, { id, from, to, kind, source: ref, certainty, method });
  }
  for (const file of files) {
    const lines = file.content.split(/\r?\n/); const fileId = node("file", file.path, source(file.path, 1, lines.length));
    let classId: string | undefined; let currentMethod: { id: string; end: number } | undefined; let component: string | undefined;
    for (let index = 0; index < lines.length; index++) {
      const lineNumber = index + 1, line = cleanLine(lines[index]), ref = source(file.path, lineNumber);
      if (file.path.endsWith(".php")) {
        const classMatch = line.match(/\bclass\s+([A-Za-z_]\w*)\b/);
        if (classMatch) { classId = node("class", `${file.path}#${classMatch[1]}`, source(file.path, lineNumber, closingLine(lines, index))); edge(fileId, classId, "declares", ref); }
        const methodMatch = line.match(/\b(public|protected|private)?\s*(?:static\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
        if (methodMatch && classId) { const id = node("method", `${file.path}#${methodMatch[2]}`, source(file.path, lineNumber, closingLine(lines, index))); edge(classId, id, "declares", ref); currentMethod = { id, end: closingLine(lines, index) }; }
        if (currentMethod && lineNumber > currentMethod.end) currentMethod = undefined;
        const owner = currentMethod?.id ?? classId ?? fileId;
        for (const match of line.matchAll(/\$this->(get_model|put_model)->([A-Za-z_]\w*)\s*\(/g)) {
          const model = match[1] === "get_model" ? "Get_model" : "Put_model";
          const target = node("method", `application/models/${model}.php#${match[2]}`, ref, "inferred"); edge(owner, target, "calls-model-method", ref, "inferred");
        }
        for (const match of line.matchAll(/\b(?:from|join|into|update)\s+([A-Za-z_]\w*)\b/gi)) {
          const table = node("table", match[1], ref); edge(owner, table, "references-table", ref);
        }
        for (const match of line.matchAll(/(?:getTbSize|getTb|insertSingleData|insertBatchData|updateData)\([^;]*?,\s*['"]([A-Za-z_]\w*)['"]\s*\)/g)) {
          const table = node("table", match[1], ref); edge(owner, table, "references-table", ref);
        }
        if (/\b(?:if|elseif)\s*\(/.test(line) && /(?:40|60|session|classto|classops|compare|score|\bca\b)/i.test(line)) {
          const branch = node("branch", `${file.path}:${lineNumber}`, ref); edge(owner, branch, "guards", ref);
        }
      } else {
        const moduleMatch = line.match(/\bangular\.module\s*\(\s*['"]([^'"]+)['"]\s*,/);
        if (moduleMatch) { const id = node("angular-module", moduleMatch[1], ref); edge(fileId, id, "declares", ref); }
        const registration = line.match(/\.(controller|service|factory)\s*\(\s*['"]([^'"]+)['"]/);
        if (registration) { component = node(registration[1] as Node["kind"], `${file.path}#${registration[2]}`, ref); edge(fileId, component, "registers", ref); }
        const owner = component ?? fileId;
        for (const match of line.matchAll(/\$http\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]|postMultiForm\s*\([^;]*?,\s*['"]([^'"]+)['"]/g)) {
          const endpoint = match[2] ?? match[3];
          if (!endpoint || !/^(?:\/|index\.php\/)[A-Za-z0-9_./-]+$/.test(endpoint) || endpoint.includes("..")) continue;
          const id = node("endpoint", endpoint, ref); edge(owner, id, "calls-endpoint", ref);
        }
      }
    }
  }
  const sortedNodes = [...nodes.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sortedEdges = [...edges.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { schemaVersion: "1.0.0", snapshotId: hash(JSON.stringify(files.map(f => [f.path, hash(f.content)]))), nodes: sortedNodes, edges: sortedEdges, warnings: warnings.sort(), limitations: ["Pattern extraction is incomplete and may match text inside strings or comments.", "Dynamic PHP calls, SQL assembly, AngularJS injection, and route aliases may be unresolved.", "Inferred model targets are call-site references until a matching declaration is observed.", "Domain labels indicate naming evidence, not usage or reachability."], scan: { fileCount: files.length, totalBytes } };
}
