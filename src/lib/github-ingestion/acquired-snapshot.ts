import "server-only";

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { allowedSource, DEFAULT_SCAN_LIMITS } from "../archaeology/selection";
import { safePath } from "../architecture/graph";

type AcquiredFile = {
  path: string;
  bytes: Buffer;
};

/**
 * Reads a bounded, verified acquisition tree.
 *
 * Only permitted source files are included.
 * Symlinks, unsafe permissions, unexpected files,
 * and changes to the acquired snapshot are rejected.
 *
 * The spool never receives credentials.
 */
export function readAcquiredSnapshot(
  root: string,
  expectedFiles: number,
  expectedBytes: number,
): AcquiredFile[] {
  if (
    !path.isAbsolute(root) ||
    realpathSync(root) !== root ||
    !Number.isSafeInteger(expectedFiles) ||
    expectedFiles < 1 ||
    expectedFiles > DEFAULT_SCAN_LIMITS.maxFiles ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > DEFAULT_SCAN_LIMITS.maxTotalBytes
  ) {
    throw new Error("Invalid acquired source bounds.");
  }

  const owner = process.getuid?.();
  const files: AcquiredFile[] = [];

  let totalBytes = 0;
  let totalEntries = 0;

  const walk = (directory: string, prefix: string): void => {
    const directoryInfo = lstatSync(directory);

    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      directoryInfo.uid !== owner ||
      (directoryInfo.mode & 0o022) !== 0
    ) {
      throw new Error("Unsafe acquired source directory.");
    }

    for (const name of readdirSync(directory)) {
      totalEntries += 1;

      if (totalEntries > 2_000) {
        throw new Error("Acquired source entry count exceeds limit.");
      }

      const relativePath = prefix ? `${prefix}/${name}` : name;

      if (!safePath(relativePath)) {
        throw new Error("Unsafe acquired source path.");
      }

      const absolutePath = path.join(directory, name);
      const entry = lstatSync(absolutePath);

      if (entry.isSymbolicLink()) {
        throw new Error("Acquired source contains a symlink.");
      }

      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }

      if (
        !entry.isFile() ||
        !allowedSource(relativePath) ||
        files.length >= expectedFiles
      ) {
        throw new Error("Acquired source contains an unexpected file.");
      }

      const fd = openSync(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );

      let bytes: Buffer;

      try {
        const fileInfo = fstatSync(fd);

        if (
          !fileInfo.isFile() ||
          fileInfo.nlink !== 1 ||
          fileInfo.uid !== owner ||
          (fileInfo.mode & 0o022) !== 0 ||
          fileInfo.size < 0 ||
          fileInfo.size > DEFAULT_SCAN_LIMITS.maxFileBytes
        ) {
          throw new Error("Unsafe acquired source file.");
        }

        bytes = readFileSync(fd);

        if (bytes.length !== fileInfo.size) {
          throw new Error("Acquired source changed during read.");
        }
      } finally {
        closeSync(fd);
      }

      totalBytes += bytes.length;

      if (totalBytes > DEFAULT_SCAN_LIMITS.maxTotalBytes) {
        throw new Error("Acquired source exceeds byte limit.");
      }

      files.push({
        path: relativePath,
        bytes,
      });
    }
  };

  walk(root, "");

  if (files.length !== expectedFiles || totalBytes !== expectedBytes) {
    throw new Error("Acquired source count or byte total changed.");
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}
