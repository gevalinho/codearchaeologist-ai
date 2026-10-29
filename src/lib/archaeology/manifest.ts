import type { Graph } from "./scanner";

export type InvestigationManifest = {
  schemaVersion: Graph["schemaVersion"];
  snapshotId: string;
  scannedAt: string;
  repositoryDisplayName: string;
  sourceCounts: { scannedFiles: number; scannedBytes: number; extractedNodes: number; extractedEdges: number };
  supportedLanguageDetections: { language: "PHP" | "JavaScript"; scannedFiles: number }[];
  warnings: string[];
  coverageLimitations: string[];
  artifacts: { graph: "graph.json"; manifest: "manifest.json" };
};


export function createManifest(graph: Graph, repositoryDisplayName: string, scannedAt: Date = new Date()): InvestigationManifest {
  const sourcePaths = new Set(graph.nodes.filter(node => node.kind === "file").map(node => node.source.path));
  return {
    schemaVersion: graph.schemaVersion, snapshotId: graph.snapshotId, scannedAt: scannedAt.toISOString(), repositoryDisplayName,
    sourceCounts: { scannedFiles: graph.scan.fileCount, scannedBytes: graph.scan.totalBytes, extractedNodes: graph.nodes.length, extractedEdges: graph.edges.length },
    supportedLanguageDetections: [
      { language: "PHP", scannedFiles: [...sourcePaths].filter(file => file.endsWith(".php")).length },
      { language: "JavaScript", scannedFiles: [...sourcePaths].filter(file => file.endsWith(".js")).length },
    ],
    warnings: graph.warnings, coverageLimitations: graph.limitations, artifacts: { graph: "graph.json", manifest: "manifest.json" },
  };
}
