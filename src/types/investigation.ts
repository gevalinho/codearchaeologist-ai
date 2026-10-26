export type VerificationStatus = "VERIFIED" | "FAILED" | "BLOCKED" | "NOT_TESTED";
export type InvestigationStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface SourceEvidence {
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}

export interface RepositoryFile {
  path: string;
  language: "javascript" | "typescript";
  bytes: number;
  lineCount: number;
  content: string;
}

export interface RepositoryInventory {
  fixtureId: string;
  files: RepositoryFile[];
  totalBytes: number;
}

export interface Precondition { description: string }
export interface ExpectedBehavior { description: string }
export interface GeneratedVerificationTest { id: string; description: string; source: string }
export interface VerificationResult {
  status: VerificationStatus;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  reason?: string;
}
export interface CandidateBusinessRule {
  id: string;
  explanation: string;
  preconditions: Precondition[];
  expectedBehavior: ExpectedBehavior;
  evidence: SourceEvidence[];
  confidence: number;
  verificationStatus: VerificationStatus;
  test?: GeneratedVerificationTest;
  verification?: VerificationResult;
}
export interface AgentAction {
  step: number;
  kind: "INSPECT" | "HYPOTHESIZE" | "REQUEST_EVIDENCE" | "REPORT";
  detail: string;
  at: string;
}
export interface Investigation {
  id: string;
  fixtureId: string;
  status: InvestigationStatus;
  startedAt: string;
  completedAt?: string;
  actions: AgentAction[];
}
export interface InvestigationReport {
  investigation: Investigation;
  inventory: RepositoryInventory;
  summary: string;
  rules: CandidateBusinessRule[];
  limitations: string[];
}
