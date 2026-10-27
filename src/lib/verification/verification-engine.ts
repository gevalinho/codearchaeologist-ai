import type { CaseObservation, ExpectedObservation, InvestigationReport, VerificationCase, VerificationResult } from "../../types/investigation";
import { DockerPricingSandbox, type SandboxRunner } from "./docker-sandbox";
import { isTrustedPricingInventory, matchPricingTemplate } from "./pricing-templates";

type ObjectValue = Record<string, unknown>;
const asObject = (value: unknown): ObjectValue | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as ObjectValue : null;

function parseObservations(stdout: string, cases: readonly VerificationCase[]): Map<string, ExpectedObservation> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const values = asObject(parsed)?.observations;
  if (!Array.isArray(values) || values.length !== cases.length) return null;
  const observations = new Map<string, ExpectedObservation>();
  const allowed = new Set(cases.map((item) => item.id));
  for (const value of values) {
    const item = asObject(value);
    if (!item || typeof item.id !== "string" || !allowed.has(item.id) || observations.has(item.id)) return null;
    if (item.kind === "return" && typeof item.value === "number" && Number.isFinite(item.value)) observations.set(item.id, { kind: "return", value: item.value });
    else if (item.kind === "throw" && typeof item.message === "string" && item.message.length <= 200) observations.set(item.id, { kind: "throw", message: item.message });
    else return null;
  }
  return observations;
}

function compareCases(cases: readonly VerificationCase[], observed: Map<string, ExpectedObservation>): CaseObservation[] {
  return cases.map((item) => {
    const actual = observed.get(item.id);
    const passed = actual?.kind === item.expected.kind && (actual.kind === "return" ? Object.is(actual.value, (item.expected as { value: number }).value) : actual.message === (item.expected as { message: string }).message);
    return { id: item.id, input: item.input, expected: item.expected, observed: actual, passed };
  });
}

export async function verifyInvestigation(report: InvestigationReport, runner: SandboxRunner = new DockerPricingSandbox()): Promise<InvestigationReport> {
  const startedAt = new Date().toISOString();
  if (!isTrustedPricingInventory(report.inventory)) {
    return { ...report, rules: report.rules.map((rule) => ({ ...rule, verificationStatus: "BLOCKED", verification: { status: "BLOCKED", reason: "Report does not contain the trusted pricing fixture" } })), limitations: [...report.limitations, "Verification accepts only the pinned legacy-pricing fixture."] };
  }
  const assignments = report.rules.map((rule) => matchPricingTemplate(rule, report.inventory));
  const cases = [...new Map(assignments.flatMap((template) => template?.cases ?? []).map((item) => [item.id, item])).values()];
  const outcome = cases.length ? await runner.run(cases) : null;
  const observed = outcome?.kind === "EXECUTED" && outcome.exitCode === 0 ? parseObservations(outcome.stdout, cases) : null;
  const rules = report.rules.map((rule, index) => {
    const template = assignments[index];
    if (!template) return { ...rule, verificationStatus: "NOT_TESTED" as const, verification: { status: "NOT_TESTED" as const, reason: "Rule does not exactly match a trusted pricing template and required source lines" } };
    const selectedCases = template.cases.map((item) => ({ ...item }));
    let result: VerificationResult;
    if (outcome?.kind === "BLOCKED") result = { status: "BLOCKED", reason: outcome.reason, durationMs: outcome.durationMs };
    else if (outcome?.kind === "TIMEOUT") result = { status: "FAILED", reason: outcome.reason, durationMs: outcome.durationMs, exitCode: outcome.exitCode ?? undefined };
    else if (outcome?.kind === "EXECUTED" && outcome.exitCode !== 0) result = { status: "FAILED", reason: "Isolated runner exited unsuccessfully", durationMs: outcome.durationMs, exitCode: outcome.exitCode ?? undefined };
    else if (outcome?.kind === "EXECUTED" && !observed) result = { status: "FAILED", reason: "Malformed isolated runner output", durationMs: outcome.durationMs, exitCode: outcome.exitCode ?? undefined };
    else if (outcome?.kind === "EXECUTED" && observed) {
      const checked = compareCases(selectedCases, observed);
      result = { status: checked.every((item) => item.passed) ? "VERIFIED" : "FAILED", cases: checked, durationMs: outcome.durationMs, exitCode: outcome.exitCode ?? undefined, output: outcome.stdout.slice(0, 16_000), reason: checked.every((item) => item.passed) ? undefined : "Observed behavior did not match trusted expectation" };
    } else result = { status: "NOT_TESTED", reason: "No eligible verification cases" };
    return { ...rule, verificationCases: selectedCases, verificationStatus: result.status, verification: result };
  });
  const actions = [...report.investigation.actions, { step: report.investigation.actions.length + 1, kind: "VERIFY" as const, detail: `Checked ${cases.length} trusted cases; isolated result ${outcome?.kind ?? "NOT_TESTED"}`, at: startedAt }];
  return { ...report, investigation: { ...report.investigation, actions }, rules, summary: `${rules.filter((rule) => rule.verificationStatus === "VERIFIED").length} rule(s) verified by isolated execution; ${rules.filter((rule) => rule.verificationStatus === "FAILED").length} failed; ${rules.filter((rule) => rule.verificationStatus === "BLOCKED").length} blocked.`, limitations: [...report.limitations.filter((item) => item !== "Phase 3 sandbox execution is not implemented."), "Verification is limited to the pinned legacy-pricing fixture and exact trusted rule templates."] };
}
