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
export interface PricingInput { subtotalCents: number; customerYears: number; promoCode: string | null }
export type ExpectedObservation = { kind: "return"; value: number } | { kind: "throw"; message: string };
export interface VerificationCase { id: string; description: string; input: PricingInput; expected: ExpectedObservation }
export interface CaseObservation { id: string; input: PricingInput; expected: ExpectedObservation; observed?: ExpectedObservation; passed: boolean }
export interface VerificationResult {
  status: VerificationStatus;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  reason?: string;
  cases?: CaseObservation[];
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
  verificationCases?: VerificationCase[];
  supportStatus?: "SUPPORTED" | "REJECTED";
}
export interface RejectedHypothesis { id: string; reason: string }
export interface ModelTrace { provider: "META" | "BASETEN" | "MOCK"; model: string; calls: number; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; latencyMs: number }
export interface AgentAction {
  step: number;
  kind: "INSPECT" | "HYPOTHESIZE" | "REQUEST_EVIDENCE" | "REPORT" | "VERIFY";
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
  selection?: { method: "DETERMINISTIC_SINGLE_FILE" | "MODEL"; paths: string[] };
  summary: string;
  rules: CandidateBusinessRule[];
  limitations: string[];
  rejectedHypotheses?: RejectedHypothesis[];
  model?: ModelTrace;
}
