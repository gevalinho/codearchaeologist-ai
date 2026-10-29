import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parseGraph } from "../architecture/graph";
import { scanRepository, type Graph, type ScanLimits } from "./scanner";
import { createManifest, type InvestigationManifest } from "./manifest";
export type { InvestigationManifest } from "./manifest";


async function safeOutputDirectory(directory: string): Promise<string> {
  if (!directory || /^[a-z][a-z\d+.-]*:\/\//i.test(directory) || directory.includes("\0") || directory.split(/[\\/]/).includes("..")) throw new Error("Output directory must be a local path without traversal.");
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error("Output directory cannot contain symlinks.");
      if (!entry.isDirectory()) throw new Error("Output path contains a non-directory entry.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  return absolute;
}

async function writeArtifact(directory: string, name: string, content: string): Promise<void> {
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); } finally { await file.close(); }
    await rename(temporary, path.join(directory, name));
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function ingestRepository(options: { repo: string; out?: string; limits?: ScanLimits; scannedAt?: Date }): Promise<{ graph: Graph; manifest: InvestigationManifest; directory: string }> {
  const graph = await scanRepository(options.repo, options.limits);
  const graphJson = `${JSON.stringify(graph, null, 2)}\n`;
  parseGraph(graphJson);
  const manifest = createManifest(graph, path.basename(options.repo.replace(/[\\/]+$/, "")), options.scannedAt);
  const directory = await safeOutputDirectory(options.out ?? path.resolve(".local-archaeology"));
  await writeArtifact(directory, "graph.json", graphJson);
  await writeArtifact(directory, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { graph, manifest, directory };
}
