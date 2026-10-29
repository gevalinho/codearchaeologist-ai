import "server-only";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { allowedSource, DEFAULT_SCAN_LIMITS } from "../archaeology/selection";
import { safePath } from "../architecture/graph";
import type { GitHubRepository } from "./url";
import { fixedHostFetch, type FixedHostFetch } from "./network";
import { parsePublicGitHubUrl } from "./url";
import { selectBoundedSource } from "./select-source";

type TreeEntry = { path: string; mode: string; type: string; sha: string; size: number };
export type AcquisitionDiagnostics = { metadataCommitMs?: number; treeMs?: number; selectionMs?: number; blobAcquisitionMs?: number; selectedBlobs: number; completedBlobs: number; failedBlobs: number };
export type AcquisitionProgress = (diagnostics: AcquisitionDiagnostics) => void;
const elapsedMs = (started: number) => Math.max(0, Math.round(performance.now() - started));
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const json = (bytes: Buffer): unknown => { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("GitHub returned malformed repository metadata."); } };
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export async function acquirePublicRepository(repo: GitHubRepository, destination: string, signal: AbortSignal, fetchFixed: FixedHostFetch = fixedHostFetch, installationToken?: string, onProgress?: AcquisitionProgress): Promise<{ sourceFiles: number; eligibleFiles: number; omittedFiles: number; sourceBytes: number; skippedFiles: number; treeEntries: number; commitSha: string; canonicalOwner?: string; canonicalName?: string }> {
  let diagnostics: AcquisitionDiagnostics = { selectedBlobs: 0, completedBlobs: 0, failedBlobs: 0 };
  const report = (update: Partial<AcquisitionDiagnostics>) => { diagnostics = { ...diagnostics, ...update }; onProgress?.({ ...diagnostics }); };
  const metadataStarted = performance.now();
  let base = `/repos/${repo.owner}/${repo.repo}`;
  const auth = installationToken ? { bearer: installationToken } : undefined;
  const metadata = json(await fetchFixed("api.github.com", base, 1_000_000, signal, installationToken ? auth : { repositoryMove: true }));
  if (!object(metadata) || !installationToken && metadata.private !== false || typeof metadata.default_branch !== "string" || !metadata.default_branch || metadata.default_branch.length > 200 || !Number.isSafeInteger(metadata.size) || (metadata.size as number) < 0) throw new Error("Repository access or GitHub metadata is invalid.");
  let canonical = repo;
  if (!installationToken && typeof metadata.full_name === "string") {
    canonical = parsePublicGitHubUrl(`https://github.com/${metadata.full_name}`);
    base = `/repos/${canonical.owner}/${canonical.repo}`;
  }
  const commit = json(await fetchFixed("api.github.com", `${base}/commits/${encodeURIComponent(metadata.default_branch)}`, 1_000_000, signal, auth));
  if (!object(commit) || !sha(commit.sha) || !object(commit.commit) || !object(commit.commit.tree) || !sha(commit.commit.tree.sha)) throw new Error("GitHub commit metadata is invalid.");
  const commitSha = commit.sha;
  report({ metadataCommitMs: elapsedMs(metadataStarted) });
  const treeStarted = performance.now();
  const tree = json(await fetchFixed("api.github.com", `${base}/git/trees/${commit.commit.tree.sha}?recursive=1`, 8 * 1024 * 1024, signal, auth));
  if (!object(tree) || tree.truncated !== false || tree.sha !== commit.commit.tree.sha || !Array.isArray(tree.tree) || tree.tree.length > 100_000) throw new Error("GitHub tree is incomplete or exceeds the tree limit.");
  const eligible: TreeEntry[] = [];
  const paths = new Set<string>();
  let skippedFiles = 0;
  for (const item of tree.tree) {
    if (!object(item) || typeof item.path !== "string" || !safePath(item.path) || paths.has(item.path) || !sha(item.sha) || !(
      item.type === "tree" && item.mode === "040000" ||
      item.type === "commit" && item.mode === "160000" ||
      item.type === "blob" && ["100644", "100755", "120000"].includes(item.mode as string)
    )) throw new Error("GitHub tree contains invalid or duplicate entries.");
    paths.add(item.path);
    if (item.type === "blob" && item.mode !== "120000" && (!Number.isSafeInteger(item.size) || (item.size as number) < 0)) throw new Error("GitHub source metadata is invalid.");
    if (item.type === "tree") continue;
    if (item.type !== "blob" || item.mode === "120000" || !allowedSource(item.path)) { skippedFiles++; continue; }
    eligible.push(item as TreeEntry);
  }
  if (!eligible.length) throw new Error("No supported source files were found in this repository.");
  if (installationToken && eligible.length > DEFAULT_SCAN_LIMITS.maxFiles) throw new Error("Eligible file count exceeds the scanner limit.");
  report({ treeMs: elapsedMs(treeStarted) });
  const selectionStarted = performance.now();
  const selected = !installationToken && eligible.length > DEFAULT_SCAN_LIMITS.maxFiles ? selectBoundedSource(eligible) : eligible.sort((a, b) => a.path.localeCompare(b.path));
  if (!selected.length) throw new Error("No supported source files fit the scanner byte limits.");
  const sourceBytes = selected.reduce((sum, item) => sum + item.size, 0);
  if (selected.some(item => item.size > DEFAULT_SCAN_LIMITS.maxFileBytes) || sourceBytes > DEFAULT_SCAN_LIMITS.maxTotalBytes) throw new Error("Eligible source files exceed the scanner byte limits.");
  report({ selectionMs: elapsedMs(selectionStarted), selectedBlobs: selected.length });
  await mkdir(destination, { recursive: true, mode: 0o755 });
  let downloaded = 0;
  const blobsStarted = performance.now(), failure = new AbortController();
  const requestSignal = AbortSignal.any([signal, failure.signal]);
  let nextIndex = 0, firstError: unknown;
  const worker = async () => {
    while (nextIndex < selected.length && !firstError && !requestSignal.aborted) {
      const item = selected[nextIndex++];
      try {
        const rawPath = `/${canonical.owner}/${canonical.repo}/${commitSha}/${item.path.split("/").map(encodeURIComponent).join("/")}`;
        let bytes: Buffer;
        if (installationToken) {
          const blob = json(await fetchFixed("api.github.com", `${base}/git/blobs/${item.sha}`, 4 * 1024 * 1024, requestSignal, auth));
          if (!object(blob) || blob.encoding !== "base64" || typeof blob.content !== "string" || !/^[A-Za-z0-9+/=\r\n]+$/.test(blob.content)) throw new Error("GitHub source blob encoding is invalid.");
          bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
        } else {
          bytes = await fetchFixed("raw.githubusercontent.com", rawPath, Math.min(DEFAULT_SCAN_LIMITS.maxFileBytes, item.size + 1), requestSignal);
        }
        if (requestSignal.aborted) throw new Error("GitHub acquisition cancelled.");
        if (bytes.length !== item.size || blobSha(bytes) !== item.sha) throw new Error("GitHub source content did not match the selected commit tree.");
        // No await between the shared budget check and increment: one worker reserves each verified blob atomically.
        if (downloaded + bytes.length > DEFAULT_SCAN_LIMITS.maxTotalBytes) throw new Error("Downloaded source exceeds the scanner byte limit.");
        downloaded += bytes.length;
        const target = path.join(destination, item.path);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        if (requestSignal.aborted) throw new Error("GitHub acquisition cancelled.");
        const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
        try { await file.writeFile(bytes); } finally { await file.close(); }
        if (requestSignal.aborted) throw new Error("GitHub acquisition cancelled.");
        report({ completedBlobs: diagnostics.completedBlobs + 1, blobAcquisitionMs: elapsedMs(blobsStarted) });
      } catch (error) {
        report({ failedBlobs: diagnostics.failedBlobs + 1, blobAcquisitionMs: elapsedMs(blobsStarted) });
        if (!firstError) { firstError = error; failure.abort(); }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: installationToken ? 1 : Math.min(4, selected.length) }, () => worker()));
    if (signal.aborted) throw new Error("GitHub acquisition cancelled.");
    if (firstError) throw firstError;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  report({ blobAcquisitionMs: elapsedMs(blobsStarted) });
  return { sourceFiles: selected.length, eligibleFiles: eligible.length, omittedFiles: eligible.length - selected.length, sourceBytes: downloaded, skippedFiles, treeEntries: tree.tree.length, commitSha, canonicalOwner: canonical.owner, canonicalName: canonical.repo };
}
