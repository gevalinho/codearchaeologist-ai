import type { CandidateBusinessRule, RepositoryInventory, SourceEvidence } from "../../types/investigation";

export function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 &&
    !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    !value.startsWith("/") && !/^[a-zA-Z]:/.test(value);
}

export function validateEvidence(inventory: RepositoryInventory, value: unknown): SourceEvidence {
  if (typeof value !== "object" || value === null) throw new Error("Evidence must be an object");
  const candidate = value as Record<string, unknown>;
  if (!isSafeRelativePath(candidate.path)) throw new Error("Invalid evidence path");
  const file = inventory.files.find((item) => item.path === candidate.path);
  if (!file) throw new Error("Evidence file was not inventoried");
  const { startLine, endLine } = candidate;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
      (startLine as number) < 1 || (endLine as number) < (startLine as number) ||
      (endLine as number) > file.lineCount) throw new Error("Invalid evidence line range");
  const excerpt = file.content.split("\n").slice((startLine as number) - 1, endLine as number).join("\n");
  if (candidate.excerpt !== undefined && candidate.excerpt !== excerpt) throw new Error("Evidence excerpt does not match source");
  return { path: file.path, startLine: startLine as number, endLine: endLine as number, excerpt };
}

export function validateCandidateRule(inventory: RepositoryInventory, value: unknown): CandidateBusinessRule {
  if (typeof value !== "object" || value === null) throw new Error("Rule must be an object");
  const rule = value as Record<string, unknown>;
  if (typeof rule.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id)) throw new Error("Invalid rule id");
  if (typeof rule.explanation !== "string" || !rule.explanation.trim()) throw new Error("Missing explanation");
  if (!Array.isArray(rule.preconditions) || !rule.preconditions.every((p) => typeof p?.description === "string" && p.description.trim())) throw new Error("Invalid preconditions");
  if (typeof rule.expectedBehavior !== "object" || rule.expectedBehavior === null || typeof (rule.expectedBehavior as Record<string, unknown>).description !== "string") throw new Error("Invalid expected behavior");
  if (!Array.isArray(rule.evidence) || rule.evidence.length === 0) throw new Error("Rule needs evidence");
  if (typeof rule.confidence !== "number" || !Number.isFinite(rule.confidence) || rule.confidence < 0 || rule.confidence > 1) throw new Error("Invalid confidence");
  if (!(["VERIFIED", "FAILED", "BLOCKED", "NOT_TESTED"] as unknown[]).includes(rule.verificationStatus)) throw new Error("Invalid verification status");
  return { ...rule, evidence: rule.evidence.map((e) => validateEvidence(inventory, e)) } as CandidateBusinessRule;
}
