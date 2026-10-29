import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestRepository } from "../src/lib/archaeology/ingestion";
import { parseGraph } from "../src/lib/architecture/graph";

const created: string[] = [];
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "ingestion-")); created.push(base);
  const repo = path.join(base, "demo-repository");
  await mkdir(path.join(repo, "application/controllers"), { recursive: true });
  await mkdir(path.join(repo, "assets/js"), { recursive: true });
  await mkdir(path.join(repo, "application/vendor"), { recursive: true });
  await writeFile(path.join(repo, "application/controllers/Promotion.php"), "<?php\nclass Promotion { public function putPromotion() {} }\n");
  await writeFile(path.join(repo, "application/controllers/credentials.php"), "private");
  await writeFile(path.join(repo, "assets/js/demo.js"), "ignored");
  await writeFile(path.join(repo, "application/vendor/Hidden.php"), "<?php class Hidden {} ");
  await symlink(path.join(repo, "application/controllers/Promotion.php"), path.join(repo, "application/controllers/Linked.php"));
  return { base, repo, out: path.join(base, "output") };
}
afterEach(async () => { await Promise.all(created.splice(0).map(item => rm(item, { recursive: true, force: true }))); });

describe("local repository ingestion", () => {
  it("exports a validated workspace graph and privacy-safe manifest", async () => {
    const { base, repo, out } = await fixture();
    const first = await ingestRepository({ repo, out, scannedAt: new Date("2026-01-01T00:00:00.000Z") });
    const serialized = await readFile(path.join(out, "graph.json"), "utf8");
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    expect(parseGraph(serialized)).toEqual(first.graph);
    expect(() => parseGraph(serialized.replace('"schemaVersion": "1.0.0"', '"schemaVersion": "invalid"'))).toThrow("schema");
    expect(first.graph.scan.fileCount).toBe(1);
    expect(first.graph.warnings).toContain("Skipped symlink: application/controllers/Linked.php");
    expect(first.graph.nodes.some(node => node.name.includes("Hidden") || node.name.includes("credentials"))).toBe(false);
    expect(manifest).toEqual(first.manifest);
    expect(manifest.repositoryDisplayName).toBe("demo-repository");
    expect(manifest.sourceCounts).toEqual({ scannedFiles: 1, scannedBytes: first.graph.scan.totalBytes, extractedNodes: first.graph.nodes.length, extractedEdges: first.graph.edges.length });
    expect(manifest.supportedLanguageDetections).toEqual([{ language: "PHP", scannedFiles: 1 }, { language: "JavaScript", scannedFiles: 0 }]);
    expect(JSON.stringify(manifest)).not.toContain(base);
    expect(serialized).not.toContain("private");
    const second = await ingestRepository({ repo, out, scannedAt: new Date("2026-01-02T00:00:00.000Z") });
    expect(second.graph).toEqual(first.graph);
    expect(second.manifest.scannedAt).not.toBe(first.manifest.scannedAt);
  });
  it("rejects invalid roots and unsafe output directories", async () => {
    const { base, repo } = await fixture();
    await expect(ingestRepository({ repo: "https://example.com/repo" })).rejects.toThrow("absolute");
    await expect(ingestRepository({ repo, out: "https://example.com/out" })).rejects.toThrow("local path");
    await expect(ingestRepository({ repo: path.join(base, "missing") })).rejects.toThrow();
    await expect(ingestRepository({ repo, out: `${base}/../escape` })).rejects.toThrow("traversal");
    await writeFile(path.join(base, "not-directory"), "x");
    await expect(ingestRepository({ repo, out: path.join(base, "not-directory") })).rejects.toThrow("non-directory");
    await symlink(base, path.join(base, "link"));
    await expect(ingestRepository({ repo, out: path.join(base, "link", "out") })).rejects.toThrow("symlinks");
    await symlink(repo, path.join(base, "repo-link"));
    await expect(ingestRepository({ repo: path.join(base, "repo-link") })).rejects.toThrow("symlink");
  });
});
