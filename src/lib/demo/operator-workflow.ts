import type { ModelProvider, SafeCompletionMetadata } from "../ai/model-provider";
import type { SandboxRunner } from "../verification/docker-sandbox";
import type { InvestigationReport } from "../../types/investigation";
import { investigateFixture } from "../agents/investigation-orchestrator";
import { InvestigationError, type InvestigationDiagnosticCategory, type InvestigationStep } from "../agents/investigation-orchestrator";
import { ModelProviderError } from "../ai/model-provider";
import { verifyInvestigation } from "../verification/verification-engine";
import { FIXTURE_ID, FIXTURE_ROOT } from "./fixture";
import { serializeDemoArtifact } from "./report-artifact";

export type OperatorStage = "CONFIGURATION" | "INVESTIGATION" | "VERIFICATION" | "ARTIFACT_VALIDATION" | "REPORT_WRITE";
export interface SafeInvestigationDiagnostic { step: InvestigationStep; category: InvestigationDiagnosticCategory; httpStatus?: number; completion?: SafeCompletionMetadata }

export class OperatorWorkflowError extends Error {
  constructor(readonly stage: OperatorStage, readonly diagnostic?: SafeInvestigationDiagnostic) { super("Operator workflow failed"); this.name = "OperatorWorkflowError"; }
}

export function formatOperatorDiagnostic(error: unknown, stage: OperatorStage): string {
  const failureStage = error instanceof OperatorWorkflowError ? error.stage : stage;
  const lines = [`Failure stage: ${failureStage}`];
  if (error instanceof OperatorWorkflowError && error.diagnostic) {
    lines.push(`Investigation step: ${error.diagnostic.step}`, `Error category: ${error.diagnostic.category}`);
    if (error.diagnostic.httpStatus !== undefined) lines.push(`HTTP status: ${error.diagnostic.httpStatus}`);
    if (error.diagnostic.completion) {
      lines.push(`Finish reason: ${error.diagnostic.completion.finishReason}`);
      if (error.diagnostic.completion.outputTokens !== undefined) lines.push(`Output tokens: ${error.diagnostic.completion.outputTokens}`);
      if (error.diagnostic.completion.reasoningTokens !== undefined) lines.push(`Reasoning tokens: ${error.diagnostic.completion.reasoningTokens}`);
    }
  } else if (stage === "CONFIGURATION" && error instanceof ModelProviderError && error.code === "CONFIG") {
    lines.push("Error category: PROVIDER_CONFIG");
  }
  return lines.join("\n") + "\n";
}

export async function buildOperatorArtifact(provider: ModelProvider, runner: SandboxRunner): Promise<{ report: InvestigationReport; artifact: string }> {
  let report: InvestigationReport;
  try { report = await investigateFixture({ fixtureId: FIXTURE_ID, fixtureRoot: FIXTURE_ROOT, provider }); }
  catch (error) {
    if (error instanceof InvestigationError) throw new OperatorWorkflowError("INVESTIGATION", { step: error.step, category: error.category, httpStatus: error.httpStatus, completion: error.completion });
    throw new OperatorWorkflowError("INVESTIGATION", { step: "INVENTORY", category: "INVESTIGATION_INTERNAL" });
  }
  try { report = await verifyInvestigation(report, runner); }
  catch { throw new OperatorWorkflowError("VERIFICATION"); }
  try { return { report, artifact: serializeDemoArtifact(report) }; }
  catch { throw new OperatorWorkflowError("ARTIFACT_VALIDATION"); }
}
