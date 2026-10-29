import type { EvidencePacket } from "./ai-evidence";
import type { RepositoryEvidencePacket } from "./ai-repository-evidence";
import type { ChatTurn } from "./ai-chat";

export type AssistantScope = "repository" | "feature";
export type AssistantPacket = EvidencePacket | RepositoryEvidencePacket;
export type AssistantMessage = { question: string; answer: string; evidenceIds: string[]; uncertainty: string; status: string };
export type AssistantThread = { messages: AssistantMessage[]; history: ChatTurn[] };
export const emptyAssistantThread = (): AssistantThread => ({ messages: [], history: [] });

/** Exact in-memory identity: even a single changed reference requires new consent. */
export function assistantContextId(scope: AssistantScope, packet: AssistantPacket | null): string | null {
  if (!packet || (scope === "repository") !== ("scope" in packet)) return null;
  return `${scope}:${JSON.stringify(packet)}`;
}
export const assistantNeedsConsent = (id: string | null, approved: ReadonlySet<string>): boolean => !!id && !approved.has(id);

export function appendAssistantAnswer(thread: AssistantThread, question: string, message: Omit<AssistantMessage, "question">): AssistantThread {
  return { messages: [...thread.messages, { question, ...message }], history: [...thread.history, { role: "user" as const, text: question }, { role: "assistant" as const, text: message.answer, evidenceIds: message.evidenceIds }].slice(-6) };
}
