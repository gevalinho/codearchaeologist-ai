import { describe, expect, it } from "vitest";
import { selectBoundedSource } from "../src/lib/github-ingestion/select-source";
import { parseGraph } from "../src/lib/architecture/graph";
import type { Graph } from "../src/lib/archaeology/scanner";
import { createEvidencePacket, parseEvidencePacket } from "../src/lib/architecture/ai-evidence";
import { createRepositoryEvidencePacket, parseRepositoryEvidencePacket } from "../src/lib/architecture/ai-repository-evidence";
import { discoverFeatures } from "../src/lib/architecture/features";
import { planReconstruction } from "../src/lib/architecture/reconstruction-planner";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SourceCoverageBanner from "../src/app/architecture/source-coverage-banner";
import RepositoryAiPanel from "../src/app/architecture/repository-ai-panel";

const entry = (path: string, size = 20) => ({ path, size, sha: "a".repeat(40), type: "blob", mode: "100644" });
const coverage = { eligibleFiles: 420, selectedFiles: 300, omittedFiles: 120, analyzedFiles: 299, skippedFiles: 30, partial: true };
const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "partial", nodes: [
  { id: "a", name: "OrderController", kind: "controller", domain: "unknown", certainty: "observed", method: "fixture", source: { path: "app/Http/Controllers/Order.php", startLine: 2, endLine: 2 } },
  { id: "b", name: "OrderAction", kind: "method", domain: "unknown", certainty: "observed", method: "fixture", source: { path: "app/Http/Controllers/Order.php", startLine: 3, endLine: 3 } },
], edges: [], rules: [], scan: { fileCount: 299, totalBytes: 800 }, sourceCoverage: coverage, warnings: [], limitations: ["Partial source analysis."] };

describe("bounded partial GitHub source selection", () => {
  it("is deterministic and represents architectural roles and directories", () => {
    const files = [
      ...Array.from({ length: 360 }, (_, i) => entry(`app/Http/Controllers/Controller${i}.php`)),
      ...Array.from({ length: 30 }, (_, i) => entry(`app/Models/Model${i}.php`)),
      ...Array.from({ length: 20 }, (_, i) => entry(`app/Services/Service${i}.php`)),
      ...Array.from({ length: 10 }, (_, i) => entry(`src/Module${i}/Worker.php`)),
    ];
    const chosen = selectBoundedSource(files);
    expect(chosen).toHaveLength(300);
    expect(selectBoundedSource([...files].reverse())).toEqual(chosen);
    expect(chosen.some(file => file.path.includes("/Models/"))).toBe(true);
    expect(chosen.some(file => file.path.includes("/Services/"))).toBe(true);
    expect(chosen.some(file => file.path.includes("src/Module"))).toBe(true);
  });

  it("keeps source byte limits while omitting oversized or over-budget candidates", () => {
    const files = [entry("app/Services/Huge.php", 2 * 1024 * 1024 + 1), ...Array.from({ length: 320 }, (_, i) => entry(`app/Http/Controllers/C${i}.php`, 50_000))];
    const chosen = selectBoundedSource(files);
    expect(chosen.length).toBeLessThanOrEqual(300);
    expect(chosen.some(file => file.path.endsWith("Huge.php"))).toBe(false);
    expect(chosen.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(12 * 1024 * 1024);
  });

  it("preserves validated graph coverage in feature and repository AI packets", () => {
    expect(parseGraph(JSON.stringify(graph)).sourceCoverage).toEqual(coverage);
    expect(() => parseGraph(JSON.stringify({ ...graph, sourceCoverage: { ...coverage, omittedFiles: 119 } }))).toThrow(/coverage/);
    const feature = discoverFeatures(graph)[0];
    const featurePacket = createEvidencePacket(graph, feature, planReconstruction(graph, feature), "public-github");
    const repositoryPacket = createRepositoryEvidencePacket(graph, [feature], "public-github");
    expect(featurePacket.sourceCoverage).toEqual(coverage);
    expect(repositoryPacket.sourceCoverage).toEqual(coverage);
    expect(featurePacket.limitations.join(" ")).toContain("Partial source analysis");
    expect(repositoryPacket.limitations.join(" ")).toContain("Partial source analysis");
    expect(() => parseEvidencePacket({ ...featurePacket, sourceCoverage: { ...coverage, selectedFiles: 301 } })).toThrow();
    expect(() => parseRepositoryEvidencePacket({ ...repositoryPacket, sourceCoverage: { ...coverage, selectedFiles: 301 } })).toThrow();
  });

  it("renders explicit partial counts and missing-feature caution", () => {
    const banner = renderToStaticMarkup(createElement(SourceCoverageBanner, { coverage }));
    expect(banner).toContain("Partial source analysis");
    expect(banner).toContain("420 eligible");
    expect(banner).toContain("120 omitted");
    expect(banner).toContain("299 analyzed");
    expect(banner).toContain("cannot be treated as absent");
    const packet = createRepositoryEvidencePacket(graph, discoverFeatures(graph), "public-github");
    const panel = renderToStaticMarkup(createElement(RepositoryAiPanel, { packet, onFocusEvidence: () => undefined, onSelectedFeature: () => undefined }));
    expect(panel).toContain("Partial source analysis");
    expect(panel).toContain("Missing features or relationships cannot be ruled out");
  });
});
