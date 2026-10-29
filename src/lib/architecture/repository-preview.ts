import type { Graph } from "../archaeology/scanner";
import type { EvidenceOrigin } from "./ai-evidence";
import { validGitHubSourceIdentity } from "./graph";

export function repositoryPreview(graph: Graph, origin: EvidenceOrigin | null, localName?: string) {
  const publicSource = origin === "public-github" && validGitHubSourceIdentity(graph.githubSource) && graph.githubSource.visibility === "public" ? graph.githubSource : null;
  const kind = publicSource ? "public" : origin === "private-github" ? "private" : origin === "browser-local" ? "local" : "artifact";
  const coverage = graph.sourceCoverage;
  return {
    kind,
    name: publicSource?.name ?? (kind === "private" ? "Private GitHub repository" : localName || "Architecture graph"),
    owner: publicSource?.owner ?? null,
    repositoryUrl: publicSource ? `https://github.com/${publicSource.owner}/${publicSource.name}` : null,
    avatarUrl: publicSource ? `https://avatars.githubusercontent.com/${publicSource.owner}?s=128` : null,
    commit: publicSource?.commitSha.slice(0, 7) ?? null,
    coverage: coverage ? { eligible: coverage.eligibleFiles, selected: coverage.selectedFiles, analyzed: coverage.analyzedFiles, omitted: coverage.omittedFiles, partial: coverage.partial, percent: coverage.eligibleFiles > 0 ? Math.round(coverage.analyzedFiles / coverage.eligibleFiles * 100) : null } : null,
    analyzed: graph.scan.fileCount,
  };
}
