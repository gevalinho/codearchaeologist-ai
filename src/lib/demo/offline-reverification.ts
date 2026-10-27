import "server-only";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { InvestigationReport, VerificationStatus } from "../../types/investigation";
import type { SandboxRunner } from "../verification/docker-sandbox";
import { matchPricingTemplate } from "../verification/pricing-templates";
import { verifyInvestigation } from "../verification/verification-engine";
import { serializeDemoArtifact, validateDemoArtifact } from "./report-artifact";

export const MAX_SAVED_REPORT_BYTES = 128 * 1024;
export type VerificationCounts = Record<VerificationStatus, number>;

/** The CLI supplies its fixed path; this helper accepts a path only for local tests. */
export async function readBoundedReport(filePath: string): Promise<unknown> {
  const directory = await lstat(path.dirname(filePath));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid report directory");
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SAVED_REPORT_BYTES) throw new Error("Invalid report file");
    const bytes = Buffer.alloc(MAX_SAVED_REPORT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SAVED_REPORT_BYTES) throw new Error("Report exceeds size limit");
    return JSON.parse(bytes.toString("utf8", 0, length)) as unknown;
  } finally { await file.close(); }
}

export async function reverifySavedArtifact(value: unknown, runner: SandboxRunner): Promise<{ artifact: string; counts: VerificationCounts; report: InvestigationReport }> {
  const saved = validateDemoArtifact(value);
  if (saved.execution !== "NOT_EXECUTED" || saved.report.rules.length === 0) throw new Error("Report is not eligible for offline verification");
  for (const rule of saved.report.rules) {
    const verification = rule.verification;
    if (rule.supportStatus !== "SUPPORTED" || rule.verificationStatus !== "NOT_TESTED" ||
        rule.test !== undefined || rule.verificationCases !== undefined ||
        !verification || verification.status !== "NOT_TESTED" || verification.cases !== undefined ||
        verification.output !== undefined || verification.exitCode !== undefined ||
        !matchPricingTemplate({ ...rule, verification: undefined }, saved.report.inventory)) {
      throw new Error("Report contains an unsupported or previously executed rule");
    }
  }
  const clean: InvestigationReport = {
    ...saved.report,
    investigation: { ...saved.report.investigation, actions: saved.report.investigation.actions.filter((action) => action.kind !== "VERIFY") },
    rules: saved.report.rules.map((rule) => ({
      id: rule.id, explanation: rule.explanation, preconditions: rule.preconditions,
      expectedBehavior: rule.expectedBehavior, evidence: rule.evidence,
      confidence: rule.confidence, supportStatus: rule.supportStatus,
      verificationStatus: "NOT_TESTED" as const,
    })),
  };
  const report = await verifyInvestigation(clean, runner);
  const artifact = serializeDemoArtifact(report);
  validateDemoArtifact(JSON.parse(artifact) as unknown);
  const counts: VerificationCounts = { VERIFIED: 0, FAILED: 0, BLOCKED: 0, NOT_TESTED: 0 };
  for (const rule of report.rules) counts[rule.verificationStatus] += 1;
  return { artifact, counts, report };
}
