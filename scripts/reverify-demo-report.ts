import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { REPORT_PATH } from "../src/lib/demo/fixture";
import { readBoundedReport, reverifySavedArtifact } from "../src/lib/demo/offline-reverification";
import { DockerPricingSandbox } from "../src/lib/verification/docker-sandbox";

const VERIFIED_REPORT_PATH = path.join(path.dirname(REPORT_PATH), "verified-report.json");

async function main() {
  const saved = await readBoundedReport(REPORT_PATH);
  const { artifact, counts } = await reverifySavedArtifact(saved, new DockerPricingSandbox());
  const directory = path.dirname(VERIFIED_REPORT_PATH);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid report directory");
  const temporary = path.join(directory, `.verified-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(artifact); } finally { await file.close(); }
    await rename(temporary, VERIFIED_REPORT_PATH);
  } finally { await unlink(temporary).catch(() => undefined); }
  process.stdout.write(`Offline report saved: ${VERIFIED_REPORT_PATH}\nVERIFIED: ${counts.VERIFIED}; FAILED: ${counts.FAILED}; BLOCKED: ${counts.BLOCKED}; NOT_TESTED: ${counts.NOT_TESTED}\nModel calls during re-verification: 0\n`);
}

main().catch(() => {
  process.stderr.write("Offline re-verification failed. Check the saved report and Docker availability.\n");
  process.exitCode = 1;
});
