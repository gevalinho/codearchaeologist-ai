import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareDirectorySelection, scanSelectedDirectory, type DirectoryFile, type BrowserScanProgress } from "../src/lib/archaeology/browser-ingestion";
import { scanRepository } from "../src/lib/archaeology/scanner";
import { parseGraph } from "../src/lib/architecture/graph";
import { discoverFeatures } from "../src/lib/architecture/features";
import { discoverModules } from "../src/lib/architecture/modules";

const file = (name: string, content: string): DirectoryFile => {
  const bytes = new TextEncoder().encode(content);
  return { webkitRelativePath: name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) };
};
const source = file("demo-repo/application/controllers/Promotion.php", "<?php\nclass Promotion {\n public function putPromotion() {}\n public function getPromotion() {}\n}\n");

describe("browser-selected repository ingestion", () => {
  it("validates, scans, and hands an import-compatible graph to features and modules", async () => {
    const phases: string[] = [];
    const result = await scanSelectedDirectory([source, file("demo-repo/application/controllers/credentials.php", "secret"), file("demo-repo/vendor/Hidden.php", "hidden")], { scannedAt: new Date("2026-01-01T00:00:00Z"), onPhase: phase => phases.push(phase) });
    expect(phases).toEqual(["validating-selection", "reading-files", "extracting-graph", "validating-artifact"]);
    expect(result.manifest.repositoryDisplayName).toBe("demo-repo");
    expect(result.manifest.sourceCounts.scannedFiles).toBe(1);
    expect(result.graph.nodes.some(node => node.name.includes("credentials") || node.name.includes("Hidden"))).toBe(false);
    expect(result.graphJson).not.toContain("secret");
    expect(parseGraph(result.graphJson)).toEqual(result.graph);
    expect(discoverFeatures(result.graph).some(feature => feature.id === "feature:promotion")).toBe(true);
    expect(discoverModules(result.graph).modules.some(module => module.id === "module:promotion")).toBe(true);
    expect(result.manifest.coverageLimitations.some(item => item.includes("symlinks"))).toBe(true);
    expect(result.manifestJson).not.toContain("<?php");
  });
  it("preserves deterministic graph IDs and source references across selection order", async () => {
    const other = file("demo-repo/assets/js/main.js", "angular.module('demo', []);\n");
    const first = await scanSelectedDirectory([source, other]);
    const second = await scanSelectedDirectory([other, source]);
    expect(first.graph).toEqual(second.graph);
    expect(first.graph.nodes.find(node => node.name.endsWith("putPromotion"))?.source.path).toBe("application/controllers/Promotion.php");
  });
  it("matches the local CLI scanner's graph identities for the same source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "browser-scan-parity-"));
    try {
      await mkdir(path.join(root, "application/controllers"), { recursive: true });
      await writeFile(path.join(root, "application/controllers/Promotion.php"), "<?php\nclass Promotion {\n public function putPromotion() {}\n public function getPromotion() {}\n}\n");
      const local = await scanRepository(root);
      const browser = await scanSelectedDirectory([source]);
      expect(browser.graph.snapshotId).toBe(local.snapshotId);
      expect(browser.graph.nodes).toEqual(local.nodes);
      expect(browser.graph.edges).toEqual(local.edges);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects ungranted, mixed-root, traversal and oversized selections", async () => {
    await expect(scanSelectedDirectory([])).rejects.toThrow("No directory");
    await expect(scanSelectedDirectory([file("/application/A.php", "x")])).rejects.toThrow("unsafe path");
    await expect(scanSelectedDirectory([file("repo/../application/A.php", "x")])).rejects.toThrow("unsafe path");
    await expect(scanSelectedDirectory([source, file("other/application/A.php", "x")])).rejects.toThrow("one repository");
    await expect(scanSelectedDirectory([source], { limits: { maxFiles: 1, maxFileBytes: 4, maxTotalBytes: 100 } })).rejects.toThrow("File size");
    await expect(scanSelectedDirectory([source], { limits: { maxFiles: 1, maxFileBytes: 100, maxTotalBytes: 4 } })).rejects.toThrow("Total byte");
  });
  it("handles cancellation, read failure and graph validation failure", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(scanSelectedDirectory([source], { signal: controller.signal })).rejects.toThrow("cancelled");
    const unreadable: DirectoryFile = { webkitRelativePath: "repo/application/A.php", size: 1, arrayBuffer: async () => { throw new Error("denied"); } };
    await expect(scanSelectedDirectory([unreadable])).rejects.toThrow("permissions");
    const invalidName = file(`repo/application/controllers/${"x".repeat(510)}.php`, "<?php class Demo {}");
    await expect(scanSelectedDirectory([invalidName])).rejects.toThrow("node structure");
  });
  it("filters a large picker file list before reading and reports measured counts", async () => {
    let excludedReads = 0;
    const excluded: DirectoryFile[] = Array.from({ length: 7700 }, (_, index) => ({ webkitRelativePath: `demo-repo/.git/objects/${index}.php`, size: 1, arrayBuffer: async () => { excludedReads++; return new Uint8Array([1]).buffer; } }));
    const prepared = prepareDirectorySelection([...excluded, source]);
    expect(prepared.progress).toMatchObject({ filesReceived: 7701, eligibleFiles: 1, filesRead: 0, bytesRead: 0 });
    expect(prepared.eligible).toEqual([source]);
    const updates: BrowserScanProgress[] = [];
    const result = await scanSelectedDirectory([...excluded, source], { onProgress: progress => updates.push(progress) });
    expect(excludedReads).toBe(0);
    expect(updates.at(-1)).toEqual({ filesReceived: 7701, eligibleFiles: 1, filesRead: 1, bytesRead: source.size, processedFiles: 1, processedBytes: source.size });
    expect(result.manifest.sourceCounts.scannedFiles).toBe(1);
  });
  it("can cancel a delayed read without completing graph handoff", async () => {
    const controller = new AbortController();
    let release!: (bytes: ArrayBuffer) => void;
    const delayed: DirectoryFile = { webkitRelativePath: "demo-repo/application/controllers/A.php", size: 1, arrayBuffer: () => new Promise(resolve => { release = resolve; }) };
    const phases: string[] = [];
    const pending = scanSelectedDirectory([delayed], { signal: controller.signal, onPhase: phase => phases.push(phase) });
    controller.abort(); release(new Uint8Array([65]).buffer);
    await expect(pending).rejects.toThrow("cancelled");
    expect(phases).toEqual(["validating-selection", "reading-files"]);
  });
});
