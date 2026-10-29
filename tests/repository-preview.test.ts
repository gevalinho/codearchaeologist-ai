import { describe, expect, it } from "vitest";
import type { Graph } from "../src/lib/archaeology/scanner";
import { parseGraph } from "../src/lib/architecture/graph";
import { repositoryPreview } from "../src/lib/architecture/repository-preview";

const graph: Graph = { schemaVersion: "1.0.0", snapshotId: "snapshot", nodes: [], edges: [], warnings: [], limitations: [], scan: { fileCount: 18, totalBytes: 500 }, sourceCoverage: { eligibleFiles: 30, selectedFiles: 20, analyzedFiles: 18, omittedFiles: 10, skippedFiles: 2, partial: true }, githubSource: { owner: "ExampleOrg", name: "ExampleRepo", commitSha: "a".repeat(40), visibility: "public" } };

describe("repository preview", () => {
  it("shows validated public identity and actual partial coverage", () => {
    const preview = repositoryPreview(parseGraph(JSON.stringify(graph)), "public-github");
    expect(preview).toMatchObject({ name: "ExampleRepo", owner: "ExampleOrg", repositoryUrl: "https://github.com/ExampleOrg/ExampleRepo", avatarUrl: "https://avatars.githubusercontent.com/ExampleOrg?s=128", commit: "aaaaaaa", coverage: { eligible: 30, selected: 20, analyzed: 18, omitted: 10, partial: true, percent: 60 } });
  });
  it("rejects malformed source identities and keeps older artifacts valid", () => {
    expect(() => parseGraph(JSON.stringify({ ...graph, githubSource: { ...graph.githubSource, owner: "evil/path" } }))).toThrow(/GitHub source identity/);
    const older = { ...graph };
    delete older.githubSource;
    expect(parseGraph(JSON.stringify(older)).githubSource).toBeUndefined();
  });
  it("does not expose private or imported identity as a public link or avatar", () => {
    const privatePreview = repositoryPreview({ ...graph, githubSource: { ...graph.githubSource!, visibility: "private" } }, "private-github");
    expect(privatePreview).toMatchObject({ name: "Private GitHub repository", owner: null, repositoryUrl: null, avatarUrl: null, commit: null });
    const importedPreview = repositoryPreview(graph, "imported-graph");
    expect(importedPreview.repositoryUrl).toBeNull();
    expect(importedPreview.avatarUrl).toBeNull();
  });
  it("uses a neutral local identity and handles missing coverage and images", () => {
    const local = repositoryPreview({ ...graph, githubSource: undefined, sourceCoverage: undefined }, "browser-local", "My local app");
    expect(local).toMatchObject({ name: "My local app", avatarUrl: null, repositoryUrl: null, coverage: null, analyzed: 18 });
  });
});
