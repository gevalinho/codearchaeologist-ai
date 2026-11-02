import type { ChatTurn } from "./ai-chat";

const MAX_AI_REQUEST_BYTES = 20_000;

export async function readAiJsonResponse(response: Pick<Response, "status" | "text">): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error(`Could not read the AI service response (HTTP ${response.status}). Retry shortly.`);
  }
  if (!text.trim()) {
    throw new Error(`The AI service returned an empty response (HTTP ${response.status}). Retry shortly.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`The AI service returned an invalid response (HTTP ${response.status}). Retry shortly.`);
  }
  if (!isAiJsonRecord(value)) {
    throw new Error(`The AI service returned an invalid response (HTTP ${response.status}). Retry shortly.`);
  }
  return value;
}

export function serializeBoundedChatRequest<T extends { history: readonly ChatTurn[] }>(request: T): string {
  let history = request.history.slice(-6);
  const encoder = new TextEncoder();
  let serialized = JSON.stringify({ ...request, history });
  while (encoder.encode(serialized).byteLength > MAX_AI_REQUEST_BYTES && history.length >= 2) {
    history = history.slice(2);
    serialized = JSON.stringify({ ...request, history });
  }
  if (encoder.encode(serialized).byteLength > MAX_AI_REQUEST_BYTES) {
    throw new Error("The AI request exceeds the bounded request limit. Narrow the question or use a smaller evidence scope.");
  }
  return serialized;
}

export function isAiJsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
