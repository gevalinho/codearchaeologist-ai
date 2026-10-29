import type { Graph, Node, Edge, Domain, SourceRef, BusinessRuleEvidence } from "./scanner";
import { codeOnLine, rulePatterns, type RuleLexicalState } from "./rule-patterns";

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
  function node(kind: Node["kind"], name: string, ref: SourceRef, certainty: Node["certainty"] = "observed", method = "deterministic-pattern-v1"): string {
    const id = stable(kind, name); const previous = nodes.get(id); if (!previous || (previous.certainty === "inferred" && certainty === "observed")) nodes.set(id, { id, kind, name, domain: domainOf(name), source: ref, certainty, method }); return id;
  }
  function edge(from: string, to: string, kind: string, ref: SourceRef, certainty: Edge["certainty"] = "observed", method = "deterministic-pattern-v1") {
    edgeRecords.set(JSON.stringify([from, to, kind, ref]), { from, to, kind, source: ref, certainty, method });
  }
  for (const file of files) {
    const lines = file.content.split(/\r?\n/); const fileId = node("file", file.path, source(file.path, 1, lines.length));
    let classId: string | undefined; let currentMethod: { id: string; end: number } | undefined; let component: string | undefined;
    const ruleState: RuleLexicalState = { blockComment: false }; const structureState: RuleLexicalState = { blockComment: false };
    for (let index = 0; index < lines.length; index++) {
      const lineNumber = index + 1, line = cleanLine(lines[index]), ref = source(file.path, lineNumber);
      if (file.path.endsWith(".php")) {
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
      const foundRules = rulePatterns(lines[index], file.path.endsWith(".php") ? currentMethod?.id ?? classId ?? fileId : component ?? fileId, ref, ruleState);
      if (rules.length < 1000) rules.push(...foundRules.slice(0, 1000 - rules.length));
    }
  }
  const sortedNodes = [...nodes.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sortedEdges = (await Promise.all([...edgeRecords].map(async ([signature, record]) => ({ ...record, id: (await hash(signature)).slice(0, 20) })))).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { schemaVersion: "1.0.0", snapshotId: await hash(JSON.stringify(await Promise.all(files.map(async f => [f.path, await hash(f.content)])))), nodes: sortedNodes, edges: sortedEdges, rules, warnings: warnings.sort(), limitations: ["PHP extraction uses line patterns, not a PHP parser; namespaces, attributes, enums, typed declarations, framework routes, hooks, and dynamic calls are not resolved.", "Pattern extraction is incomplete and may match text inside strings or comments.", "Business-rule patterns cover only single-line conditions, assignments, and arithmetic; they do not prove runtime behavior or business intent.", ...(rules.length === 1000 ? ["Business-rule evidence reached the 1,000-finding display limit; further rules may be omitted."] : []), "Dynamic PHP calls, SQL assembly, AngularJS injection, and route aliases may be unresolved.", "Inferred model targets are call-site references until a matching declaration is observed.", "Domain labels indicate naming evidence, not usage or reachability."], scan: { fileCount: files.length, totalBytes } };
}
