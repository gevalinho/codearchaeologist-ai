import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLiveModelProvider } from "../src/lib/ai/provider-selection";
import { REPORT_PATH } from "../src/lib/demo/fixture";
import { formatUsageSummary } from "../src/lib/demo/usage";
import { buildOperatorArtifact, formatOperatorDiagnostic, type OperatorStage } from "../src/lib/demo/operator-workflow";
import { DockerPricingSandbox } from "../src/lib/verification/docker-sandbox";

let stage: OperatorStage = "CONFIGURATION";

async function main() {
  const provider = createLiveModelProvider();
  const { report, artifact } = await buildOperatorArtifact(provider, new DockerPricingSandbox());
  stage = "REPORT_WRITE";
  const directory = path.dirname(REPORT_PATH);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Report directory is not trusted");
  const temporary = path.join(directory, `.report-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(artifact); } finally { await file.close(); }
    await rename(temporary, REPORT_PATH);
  } finally { await unlink(temporary).catch(() => undefined); }
  process.stdout.write(`Report saved: ${REPORT_PATH}\nProvider: ${report.model?.provider ?? "unknown"}\nModel: ${report.model?.model ?? "unknown"}\n${formatUsageSummary(report.model)}Verified: ${report.rules.filter((rule) => rule.verificationStatus === "VERIFIED").length}; not tested: ${report.rules.filter((rule) => rule.verificationStatus === "NOT_TESTED").length}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write("Operator report generation failed. Check provider configuration, fixture, and Docker availability.\n");
  if (process.env.CODEARCHAEOLOGIST_OPERATOR_DIAGNOSTICS === "1") {
    process.stderr.write(formatOperatorDiagnostic(error, stage));
  }
  process.exitCode = 1;
});
