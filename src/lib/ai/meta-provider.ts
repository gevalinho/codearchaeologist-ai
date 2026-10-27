import "server-only";
import { ModelProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from "./model-provider";

const DEFAULT_ENDPOINT = "https://api.meta.ai/v1/chat/completions";
export interface MetaProviderOptions {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetcher?: typeof fetch;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : null; }
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ModelProviderError("MALFORMED", "Meta response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 128_000) throw new ModelProviderError("MALFORMED", "Meta response exceeds size limit");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ModelProviderError("MALFORMED", "Meta response is not valid JSON"); }
}

export class MetaModelProvider implements ModelProvider {
  readonly kind = "META" as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetcher: typeof fetch;

  constructor(options: MetaProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.MODEL_API_KEY ?? "";
    this.model = options.model ?? process.env.META_MODEL_ID ?? "muse-spark-1.3";
    this.endpoint = options.endpoint ?? process.env.META_MODEL_ENDPOINT ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetcher = options.fetcher ?? fetch;
    if (!this.apiKey) throw new ModelProviderError("CONFIG", "MODEL_API_KEY is required");
    if (!this.model || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000 || !Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 2) throw new ModelProviderError("CONFIG", "Invalid Meta provider configuration");
    let url: URL;
    try { url = new URL(this.endpoint); } catch { throw new ModelProviderError("CONFIG", "Invalid Meta endpoint URL"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) throw new ModelProviderError("CONFIG", "Meta endpoint must be a plain HTTPS URL");
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const start = performance.now();
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (request.signal.aborted) throw new ModelProviderError("TIMEOUT", "Investigation deadline exceeded");
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "developer", content: request.instructions }, { role: "user", content: request.input }],
            response_format: { type: "json_schema", json_schema: { name: request.name, strict: true, schema: request.schema } },
            max_completion_tokens: request.maxOutputTokens,
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) { await this.backoff(attempt, request.signal); continue; }
          throw new ModelProviderError("HTTP", `Meta API returned HTTP ${response.status}`);
        }
        const payload = await readBoundedJson(response);
        const root = record(payload);
        const choices = root?.choices;
        const first = Array.isArray(choices) ? record(choices[0]) : null;
        if (first?.finish_reason !== "stop") throw new ModelProviderError("MALFORMED", "Meta response did not finish normally");
        const content = record(first?.message)?.content;
        if (typeof content !== "string" || content.length > 64_000) throw new ModelProviderError("MALFORMED", "Meta response has no bounded text content");
        let value: unknown;
        try { value = JSON.parse(content); } catch { throw new ModelProviderError("MALFORMED", "Meta response content is not JSON"); }
        const usage = record(root?.usage);
        const inputTokens = usage?.prompt_tokens;
        const outputTokens = usage?.completion_tokens;
        return {
          value,
          model: typeof root?.model === "string" ? root.model : this.model,
          latencyMs: performance.now() - start,
          usage: Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) ? { inputTokens: inputTokens as number, outputTokens: outputTokens as number } : undefined,
        };
      } catch (error) {
        if (error instanceof ModelProviderError) throw error;
        if (controller.signal.aborted) throw new ModelProviderError("TIMEOUT", "Meta request timed out");
        if (attempt < this.maxRetries) { await this.backoff(attempt, request.signal); continue; }
        throw new ModelProviderError("NETWORK", "Meta request failed");
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
      }
    }
    throw new ModelProviderError("NETWORK", "Meta retry limit exhausted");
  }

  private async backoff(attempt: number, signal: AbortSignal): Promise<void> {
    try { await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 200 * 2 ** attempt);
      const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
      signal.addEventListener("abort", onAbort, { once: true });
    }); } catch { throw new ModelProviderError("TIMEOUT", "Investigation deadline exceeded"); }
  }
}
