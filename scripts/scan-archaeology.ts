import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scanRepository } from "../src/lib/archaeology/scanner";

async function main() {
  const root = process.env.ARCHAEOLOGY_REPO_ROOT;
  const graph = await scanRepository(root);
  const directory = path.resolve(".local-archaeology");
  const artifactName = `graph-${graph.snapshotId}-${randomUUID()}.json`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid output directory");
  const temporary = path.join(directory, `.graph-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(`${JSON.stringify(graph, null, 2)}\n`); } finally { await file.close(); }
    await rename(temporary, path.join(directory, artifactName));
  } finally { await unlink(temporary).catch(() => undefined); }
  process.stdout.write(`Graph saved: .local-archaeology/${artifactName}\nFiles: ${graph.scan.fileCount}; nodes: ${graph.nodes.length}; edges: ${graph.edges.length}; warnings: ${graph.warnings.length}\n`);
}
main().catch((error: unknown) => { const code = error instanceof Error && "code" in error ? String(error.code) : "SCAN_ERROR"; process.stderr.write(`Repository scan failed (${code}). Check the configured root, source encoding, output permissions, and scan limits.\n`); process.exitCode = 1; });
