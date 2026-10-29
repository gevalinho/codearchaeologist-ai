import { parseGraph } from "../architecture/graph";
import { graphFromSources, type ScannedSource } from "./scanner-core";
import { createManifest, type InvestigationManifest } from "./manifest";
import { allowedSource, DEFAULT_SCAN_LIMITS } from "./selection";
import type { Graph, ScanLimits } from "./scanner";

export type DirectoryFile = Pick<File, "size" | "arrayBuffer"> & { webkitRelativePath: string };
export type BrowserScanPhase = "validating-selection" | "reading-files" | "extracting-graph" | "validating-artifact";
export type BrowserScanProgress = { filesReceived: number; eligibleFiles: number; filesRead: number; bytesRead: number; processedFiles: number; processedBytes: number };
export type BrowserIngestion = { graph: Graph; manifest: InvestigationManifest; graphJson: string; manifestJson: string };

export function prepareDirectorySelection(files: readonly DirectoryFile[], limits: ScanLimits = DEFAULT_SCAN_LIMITS): { repositoryName: string; eligible: DirectoryFile[]; progress: BrowserScanProgress } {
  if (!files.length) throw new Error("No directory was selected.");
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error("Invalid scan limits.");
  const paths = files.map(file => file.webkitRelativePath);
  const parts = paths.map(value => value.split("/"));
  if (parts.some(items => items.length < 2 || items.some(item => !item || item === "." || item === ".." || item.includes("\\") || item.includes("\0") || item.includes(":")))) throw new Error("Directory selection contains an unsafe path.");
  const repositoryName = parts[0][0];
  if (parts.some(items => items[0] !== repositoryName)) throw new Error("Select one repository directory at a time.");
  const eligible = files.map((file, index) => ({ file, relative: parts[index].slice(1).join("/") })).filter(item => allowedSource(item.relative)).sort((a, b) => a.relative.localeCompare(b.relative));
  if (!eligible.length) throw new Error("No supported application PHP or JavaScript files were found in the selected directory.");
  if (eligible.length > limits.maxFiles) throw new Error("File count limit exceeded.");
  let selectedBytes = 0;
  for (const item of eligible) {
    if (item.file.size > limits.maxFileBytes) throw new Error("File size limit exceeded.");
    selectedBytes += item.file.size;
    if (selectedBytes > limits.maxTotalBytes) throw new Error("Total byte limit exceeded.");
  }
  return { repositoryName, eligible: eligible.map(item => item.file), progress: { filesReceived: files.length, eligibleFiles: eligible.length, filesRead: 0, bytesRead: 0, processedFiles: 0, processedBytes: 0 } };
}

/** Reads only files explicitly granted by the browser's directory picker. */
export async function scanSelectedDirectory(files: readonly DirectoryFile[], options: { limits?: ScanLimits; scannedAt?: Date; signal?: AbortSignal; onPhase?: (phase: BrowserScanPhase) => void; onProgress?: (progress: BrowserScanProgress) => void } = {}): Promise<BrowserIngestion> {
  const checkCancelled = () => { if (options.signal?.aborted) throw new Error("Repository scan cancelled."); };
  checkCancelled(); options.onPhase?.("validating-selection");
  const limits = options.limits ?? DEFAULT_SCAN_LIMITS;
  const prepared = prepareDirectorySelection(files, limits);
  const selected = prepared.eligible.map(file => ({ file, relative: file.webkitRelativePath.split("/").slice(1).join("/") }));
  const progress = { ...prepared.progress };
  options.onProgress?.({ ...progress });
  if (!globalThis.crypto?.subtle) throw new Error("Repository scanning requires a secure browser context (HTTPS or localhost).");
  const sources: ScannedSource[] = [], warnings: string[] = [];
  let totalBytes = 0;
  options.onPhase?.("reading-files");
  for (const item of selected) {
    checkCancelled();
    if (item.file.size > limits.maxFileBytes) throw new Error("File size limit exceeded.");
    if (totalBytes + item.file.size > limits.maxTotalBytes) throw new Error("Total byte limit exceeded.");
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await item.file.arrayBuffer()); } catch { throw new Error("Could not read a selected file. Check browser file permissions."); }
    checkCancelled();
    progress.filesRead++; progress.bytesRead += bytes.length;
    if (bytes.length !== item.file.size || bytes.includes(0)) { warnings.push(`Skipped binary or changed source: ${item.relative}`); options.onProgress?.({ ...progress }); continue; }
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { warnings.push(`Skipped invalid UTF-8 source: ${item.relative}`); options.onProgress?.({ ...progress }); continue; }
    sources.push({ path: item.relative, content, bytes: bytes.length }); totalBytes += bytes.length;
    progress.processedFiles++; progress.processedBytes += bytes.length; options.onProgress?.({ ...progress });
  }
  if (!sources.length) throw new Error("No readable supported source files remained after validation.");
  checkCancelled(); options.onPhase?.("extracting-graph");
  const graph = await graphFromSources(sources, warnings);
  graph.limitations.push("Browser directory selection cannot verify filesystem symlinks or files omitted by the browser picker. Use the local CLI for filesystem-level checks.");
  const graphJson = `${JSON.stringify(graph, null, 2)}\n`;
  checkCancelled(); options.onPhase?.("validating-artifact");
  parseGraph(graphJson);
  const manifest = createManifest(graph, prepared.repositoryName, options.scannedAt);
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  checkCancelled();
  return { graph, manifest, graphJson, manifestJson };
}
