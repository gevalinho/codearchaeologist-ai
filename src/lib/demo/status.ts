import type { VerificationStatus } from "../../types/investigation";

export const STATUS_LABEL: Record<VerificationStatus, string> = {
  VERIFIED: "Verified by execution",
  FAILED: "Execution failed",
  BLOCKED: "Verification blocked",
  NOT_TESTED: "Not executed",
};

export function statusTone(status: VerificationStatus): string {
  return { VERIFIED: "verified", FAILED: "failed", BLOCKED: "blocked", NOT_TESTED: "untested" }[status];
}
