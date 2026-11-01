import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { graphFromSources } from "./scanner-core";
import { allowedSource, DEFAULT_SCAN_LIMITS, excludedDirectories, sourceExclusionReason } from "./selection";

export type Domain = "school-management" | "healthcare-legacy" | "shared-infrastructure" | "unknown";
export type SourceRef = { path: string; startLine: number; endLine: number };
export type Node = { id: string; kind: "file" | "class" | "method" | "angular-module" | "controller" | "service" | "factory" | "table" | "endpoint" | "branch" | "module" | "function" | "component" | "route" | "http-call"; name: string; domain: Domain; source: SourceRef; certainty: "observed" | "inferred"; method: string };
export type Edge = { id: string; from: string; to: string; kind: string; source: SourceRef; certainty: "observed" | "inferred"; method: string };
export type BusinessRuleEvidence = { id: string; kind: "condition" | "validation" | "authorization" | "state-transition" | "calculation"; description: string; ownerNodeId: string; source: SourceRef; certainty: "observed"; method: "deterministic-rule-pattern-v1" };
export type SourceCoverage = { eligibleFiles: number; selectedFiles: number; omittedFiles: number; analyzedFiles: number; skippedFiles: number; partial: boolean };
export type GitHubSourceIdentity = { owner: string; name: string; commitSha: string; visibility: "public" | "private" };
export type AdapterCapability = { adapter: string; status: "analyzed" | "partial" | "unsupported" | "not-detected"; staticRoutes: number; dynamicRoutes: number };
export type PhpRouteCapability = {
  adapter: "codeigniter-3" | "codeigniter-4" | "laravel";
  path?: string;
  methods: string[];
  target?: string;
  middleware: string[];
  source: SourceRef;
  certainty: "observed" | "inferred";
  resolution: "resolved" | "unresolved" | "ambiguous" | "dynamic";
  resolvedMethod?: string;
  parameterBindings?: { routeParameter: number; argument: number }[];
};
export type PhpRoutingCapability = {
  adapters: {
    adapter: "codeigniter-3" | "codeigniter-4" | "laravel";
    detection: "confirmed" | "probable" | "unknown";
    status: "analyzed" | "partial" | "unsupported" | "not-detected";
    staticRoutes: number;
    dynamicRoutes: number;
    ambiguousRoutes: number;
    unresolvedRoutes: number;
  }[];
  routes: PhpRouteCapability[];
};
export type AngularUiRouterState = {
  state: string;
  url?: string;
  templateUrl?: string;
  controller?: string;
  source: SourceRef;
  templateSource?: SourceRef;
  controllerSource?: SourceRef;
};
export type CrossStackMatch = {
  endpointId: string;
  frontendSource: SourceRef;
  wrapperSource?: SourceRef;
  routeIds: string[];
  backendSources: SourceRef[];
  status: "exact" | "parameterized" | "ambiguous" | "unresolved";
  reason?: "dynamic-frontend-path" | "method-mismatch" | "no-route-match" | "unsupported-backend-pattern" | "multiple-routes";
  method?: string;
  controllerActionResolved: boolean;
};
export type CrossStackCapability = {
  totalHttpCalls: number;
  omittedHttpCalls: number;
  matches: CrossStackMatch[];
  phpMethodCalls: {
    observed: number;
    unresolved: number;
    unsupported: string[];
  };
};
export type AnalysisCapabilities = {
  javascriptTypescript?: { parser: "babel"; analyzedFiles: number; unsupportedFiles: number; routingAdapters: AdapterCapability[]; uiRouterStates?: AngularUiRouterState[] };
  php?: { parser: "php-parser"; analyzedFiles: number; partialFiles: number; unsupportedFiles: number; indexedSymbols: number };
  phpRouting?: PhpRoutingCapability;
  crossStack?: CrossStackCapability;
  backendRouting?: AdapterCapability[];
};
export type Graph = { schemaVersion: "1.0.0"; snapshotId: string; nodes: Node[]; edges: Edge[]; rules?: BusinessRuleEvidence[]; warnings: string[]; limitations: string[]; scan: { fileCount: number; totalBytes: number }; analysisCapabilities?: AnalysisCapabilities; sourceCoverage?: SourceCoverage; githubSource?: GitHubSourceIdentity };
export type ScanLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
export { DEFAULT_SCAN_LIMITS } from "./selection";
export async function scanRepository(configuredRoot: string | undefined, limits: ScanLimits = DEFAULT_SCAN_LIMITS): Promise<Graph> {
  if (!configuredRoot || !path.isAbsolute(configuredRoot) || configuredRoot.includes("\0") || configuredRoot.split(path.sep).includes("..")) throw new Error("An absolute configured repository root without traversal is required");
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error("Invalid scan limits");
  if ((await lstat(configuredRoot)).isSymbolicLink()) throw new Error("Repository root cannot be a symlink");
  const root = await realpath(configuredRoot);
  if (!(await lstat(root)).isDirectory()) throw new Error("Repository root must be a directory");
  const files: { path: string; content: string; bytes: number }[] = [];
  let totalBytes = 0, eligibleFiles = 0, skippedFiles = 0;
  const warnings: string[] = [];
  async function walk(relative: string): Promise<void> {
    const entries = (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { warnings.push(`Skipped symlink: ${next}`); continue; }
      const codeIgniterConfig = next === "application/config";
      if (entry.name.startsWith(".") || excludedDirectories.has(entry.name.toLowerCase()) && !codeIgniterConfig) continue;
      if (entry.isDirectory()) { await walk(next); continue; }
      if (!entry.isFile()) continue;
      const exclusion = sourceExclusionReason(next);
      if (exclusion) {
        skippedFiles++;
        warnings.push(`Skipped recognized third-party bundle (${exclusion}): ${next}`);
        continue;
      }
      if (!allowedSource(next)) continue;
      eligibleFiles++;
      if (files.length >= limits.maxFiles) throw new Error("File count limit exceeded");
      const absolute = path.join(root, next);
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.size > limits.maxFileBytes) throw new Error("File size limit exceeded");
      if (totalBytes + metadata.size > limits.maxTotalBytes) throw new Error("Total byte limit exceeded");
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { const opened = await handle.stat(); if (!opened.isFile() || opened.size !== metadata.size) throw new Error("Source changed during scan"); bytes = await handle.readFile(); } finally { await handle.close(); }
      if (bytes.length !== metadata.size || bytes.includes(0)) { skippedFiles++; warnings.push(`Skipped binary or changed source: ${next}`); continue; }
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { skippedFiles++; warnings.push(`Skipped invalid UTF-8 source: ${next}`); continue; }
      files.push({ path: next, content, bytes: bytes.length }); totalBytes += bytes.length;
    }
  }
  await walk("");
  const graph = await graphFromSources(files, warnings);
  graph.sourceCoverage = {
    eligibleFiles,
    selectedFiles: eligibleFiles,
    omittedFiles: 0,
    analyzedFiles: graph.scan.fileCount,
    skippedFiles,
    partial: skippedFiles > 0 || graph.scan.fileCount < eligibleFiles,
  };
  return graph;
}
