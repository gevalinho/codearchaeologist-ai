import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { RepositoryFile, RepositoryInventory } from "../../types/investigation";
import { isSafeRelativePath } from "../schemas/investigation";

export interface InventoryLimits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
export const DEFAULT_LIMITS: InventoryLimits = { maxFiles: 30, maxFileBytes: 64 * 1024, maxTotalBytes: 256 * 1024 };
const excluded = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".env", ".env.local"]);

export async function inventoryFixture(
  fixtureId: string,
  fixtureRoot: string,
  limits: InventoryLimits = DEFAULT_LIMITS,
): Promise<RepositoryInventory> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(fixtureId)) throw new Error("Invalid fixture id");
  if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1)) throw new Error("Invalid inventory limits");
  const root = await realpath(fixtureRoot);
  const files: RepositoryFile[] = [];
  let totalBytes = 0;
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excluded.has(entry.name) || entry.name.startsWith(".") || /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSafeRelativePath(next) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(next); continue; }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) continue;
      if (files.length >= limits.maxFiles) throw new Error("File count limit exceeded");
      const absolute = path.join(root, next);
      const metadata = await stat(absolute);
      if (!metadata.isFile() || metadata.size > limits.maxFileBytes) throw new Error("File size limit exceeded");
      totalBytes += metadata.size;
      if (totalBytes > limits.maxTotalBytes) throw new Error("Total input limit exceeded");
      const bytes = await readFile(absolute);
      if (bytes.length !== metadata.size || bytes.includes(0)) throw new Error("Changed or binary source file");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      files.push({ path: next, language: /\.([cm]?ts|tsx)$/.test(next) ? "typescript" : "javascript", bytes: bytes.length, lineCount: content.split("\n").length, content });
    }
  }
  await walk("");
  return { fixtureId, files, totalBytes };
}
