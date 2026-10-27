export type JsonSchema = Record<string, unknown>;
export interface ModelRequest {
  name: string;
  instructions: string;
  input: string;
  schema: JsonSchema;
  maxOutputTokens: number;
  signal: AbortSignal;
}
export interface ModelResponse {
  value: unknown;
  model: string;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  diagnostics?: ModelDiagnostics;
}
export interface ModelProvider {
  readonly kind: "META" | "BASETEN" | "MOCK";
  complete(request: ModelRequest): Promise<ModelResponse>;
}
export interface ModelDiagnostics {
  httpStatus: number | null;
  finishReason: string | null;
  contentPresent: boolean;
  contentLength: number;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}
export type SafeFinishReason = "stop" | "length" | "content_filter" | "tool_calls" | "unknown";
export interface SafeCompletionMetadata { finishReason: SafeFinishReason; outputTokens?: number; reasoningTokens?: number }
export class ModelProviderError extends Error {
  constructor(readonly code: "CONFIG" | "TIMEOUT" | "HTTP" | "MALFORMED" | "NETWORK" | "INCOMPLETE", message: string, readonly diagnostics?: ModelDiagnostics) {
    super(message);
    this.name = "ModelProviderError";
  }
}
