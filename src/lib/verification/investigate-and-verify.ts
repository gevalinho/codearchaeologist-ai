import type { InvestigationReport } from "../../types/investigation";
import { investigateFixture, type InvestigationOptions } from "../agents/investigation-orchestrator";
import { DockerPricingSandbox, type SandboxRunner } from "./docker-sandbox";
import { verifyInvestigation } from "./verification-engine";

/** Explicit opt-in path; Phase 2 investigation remains unchanged. */
export async function investigateAndVerify(options: InvestigationOptions, runner: SandboxRunner = new DockerPricingSandbox()): Promise<InvestigationReport> {
  const report = await investigateFixture(options);
  return verifyInvestigation(report, runner);
}
