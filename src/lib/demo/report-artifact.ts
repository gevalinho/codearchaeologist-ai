import "server-only";
import { isTrustedPricingInventory, matchPricingTemplate } from "../verification/pricing-templates";
import { validateEvidence } from "../schemas/investigation";
import type { InvestigationReport, VerificationCase } from "../../types/investigation";
import { isBoundedUsage } from "./usage";

export interface DemoArtifact { schemaVersion: 1; provenance: "OPERATOR_WORKFLOW"; execution: "ISOLATED_DOCKER" | "NOT_EXECUTED"; generatedAt: string; report: InvestigationReport }
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown, max = 500): value is string => typeof value === "string" && value.length <= max;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const validDate = (value: unknown): value is string => string(value, 40) && !Number.isNaN(Date.parse(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function validCase(value: unknown, trusted: VerificationCase): boolean {
  const item = object(value);
  const actual = object(item?.observed);
  if (!item || item.id !== trusted.id || !same(item.input, trusted.input) || !same(item.expected, trusted.expected) || typeof item.passed !== "boolean") return false;
  if (!actual) return item.passed === false;
  if (actual.kind === "return" && !number(actual.value) || actual.kind === "throw" && !string(actual.message, 200) || !["return", "throw"].includes(String(actual.kind))) return false;
  return item.passed === same(actual, trusted.expected);
}

export function validateDemoArtifact(value: unknown): DemoArtifact {
  const artifact = object(value);
  const report = object(artifact?.report);
  const investigation = object(report?.investigation);
  const model = object(report?.model);
  const selection = object(report?.selection);
  const inventory = report?.inventory as InvestigationReport["inventory"] | undefined;
  if (!artifact || artifact.schemaVersion !== 1 || artifact.provenance !== "OPERATOR_WORKFLOW" || !["ISOLATED_DOCKER", "NOT_EXECUTED"].includes(String(artifact.execution)) || !validDate(artifact.generatedAt) || !report || !investigation || investigation.fixtureId !== "legacy-pricing" || investigation.status !== "COMPLETED" || !string(investigation.id, 100) || !validDate(investigation.startedAt) || !Array.isArray(investigation.actions) || !investigation.actions.some((a) => object(a)?.kind === "VERIFY") || !model || !["META", "BASETEN"].includes(String(model.provider)) || !string(model.model, 200) || !isBoundedUsage(model.calls) || model.calls > 3 || !number(model.latencyMs) || [model.inputTokens, model.outputTokens, model.reasoningTokens].some((count) => count !== undefined && !isBoundedUsage(count)) || !inventory || !isTrustedPricingInventory(inventory) || !selection || selection.method !== "DETERMINISTIC_SINGLE_FILE" || !same(selection.paths, ["pricing.js"]) || !Array.isArray(report.rules) || report.rules.length > 5 || !Array.isArray(report.limitations) || report.limitations.some((x) => !string(x, 500)) || !string(report.summary, 1000)) throw new Error("Invalid trusted demonstration report");
  const executed = report.rules.some((r) => r.verificationStatus === "VERIFIED" || r.verificationStatus === "FAILED");
  if (artifact.execution !== (executed ? "ISOLATED_DOCKER" : "NOT_EXECUTED")) throw new Error("Invalid execution provenance");
  for (const value of report.rules) {
    const rule = object(value);
    if (!rule || !string(rule.id, 80) || !string(rule.explanation) || !Array.isArray(rule.preconditions) || rule.preconditions.some((p) => !string(object(p)?.description, 300)) || !string(object(rule.expectedBehavior)?.description, 300) || !Array.isArray(rule.evidence) || rule.evidence.length > 3 || !["VERIFIED", "FAILED", "BLOCKED", "NOT_TESTED"].includes(String(rule.verificationStatus))) throw new Error("Invalid report rule");
    const typedRule = rule as unknown as InvestigationReport["rules"][number];
    try { typedRule.evidence.forEach((evidence) => validateEvidence(inventory, evidence)); } catch { throw new Error("Invalid source evidence"); }
    const template = matchPricingTemplate({ ...typedRule, verificationStatus: "NOT_TESTED", verification: undefined, verificationCases: undefined }, inventory);
    const verification = object(rule.verification);
    if (!verification || verification.status !== rule.verificationStatus || !string(verification.reason, 300) && verification.reason !== undefined || verification.durationMs !== undefined && !number(verification.durationMs) || verification.output !== undefined || rule.test !== undefined) throw new Error("Invalid verification result");
    const cases = verification.cases;
    if (rule.verificationStatus === "VERIFIED" || rule.verificationStatus === "FAILED") {
      if (!template || cases !== undefined && (!Array.isArray(cases) || cases.length !== template.cases.length || !template.cases.every((item, index) => validCase(cases[index], item)))) throw new Error("Invalid executed cases");
      if (rule.verificationStatus === "VERIFIED" && (!Array.isArray(cases) || cases.some((item) => object(item)?.passed !== true))) throw new Error("Unsupported verified status");
      if (rule.verificationStatus === "FAILED" && (!Array.isArray(cases) || cases.every((item) => object(item)?.passed === true)) && !["Malformed isolated runner output", "Isolated runner exited unsuccessfully", "Container exceeded five-second limit", "Docker CLI output exceeded limit"].includes(String(verification.reason))) throw new Error("Unsupported failed status");
    } else if (verification.cases !== undefined) throw new Error("Unexecuted rule contains cases");
  }
  return artifact as unknown as DemoArtifact;
}

/** Strip optional generated source and raw runner output before writing the local artifact. */
export function serializeDemoArtifact(report: InvestigationReport): string {
  const sanitized: InvestigationReport = {
    ...report,
    rules: report.rules.map((rule) => {
      const clean = { ...rule, verification: rule.verification ? { ...rule.verification, output: undefined } : undefined };
      delete clean.test;
      return clean;
    }),
  };
  const execution = sanitized.rules.some((rule) => rule.verificationStatus === "VERIFIED" || rule.verificationStatus === "FAILED") ? "ISOLATED_DOCKER" : "NOT_EXECUTED";
  const artifact: DemoArtifact = { schemaVersion: 1, provenance: "OPERATOR_WORKFLOW", execution, generatedAt: new Date().toISOString(), report: sanitized };
  validateDemoArtifact(artifact);
  return JSON.stringify(artifact, null, 2) + "\n";
}
