import type { ModelProvider, ModelRequest, ModelResponse } from "./model-provider";

/** Test-only deterministic responses; never used as a live-provider fallback. */
export class MockModelProvider implements ModelProvider {
  readonly kind = "MOCK" as const;
  readonly requests: ModelRequest[] = [];
  constructor(private readonly responses: Array<unknown | Error>, readonly model = "fixture-mock") {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (request.signal.aborted) throw new Error("Mock request aborted");
    if (this.responses.length === 0) throw new Error("Mock response queue exhausted");
    const value = this.responses.shift();
    if (value instanceof Error) throw value;
    return { value, model: this.model, latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
