import "server-only";
import { ModelProviderError, type ModelDiagnostics, type ModelProvider, type ModelRequest, type ModelResponse } from "./model-provider";

const DEFAULT_ENDPOINT = "https://inference.baseten.co/v1/chat/completions";
const DEFAULT_MODEL = "meta-models/muse-spark-open-1026";
const MAX_RESPONSE_BYTES = 128_000;

export interface BasetenProviderOptions {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  maxRetries?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  fetcher?: typeof fetch;
}

type ObjectValue = Record<string, unknown>;
const asObject = (value: unknown): ObjectValue | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as ObjectValue : null;

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ModelProviderError("MALFORMED", "Baseten response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ModelProviderError("MALFORMED", "Baseten response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ModelProviderError("MALFORMED", "Baseten response is not valid JSON"); }
}

async function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 200 * 2 ** attempt);
      const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } catch { throw new ModelProviderError("TIMEOUT", "Investigation deadline exceeded"); }
}

export class BasetenModelProvider implements ModelProvider {
  readonly kind = "BASETEN" as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  private readonly fetcher: typeof fetch;

  constructor(options: BasetenProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.BASETEN_API_KEY ?? "";
    this.model = options.model ?? process.env.BASETEN_MODEL_ID ?? DEFAULT_MODEL;
    this.endpoint = options.endpoint ?? process.env.BASETEN_MODEL_ENDPOINT ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.reasoningEffort = options.reasoningEffort;
    this.fetcher = options.fetcher ?? fetch;
    if (!this.apiKey.trim()) throw new ModelProviderError("CONFIG", "BASETEN_API_KEY is required");
    if (!this.model.trim() || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000 || !Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 2 || (this.reasoningEffort !== undefined && !(["low", "medium", "high", "xhigh"] as unknown[]).includes(this.reasoningEffort))) throw new ModelProviderError("CONFIG", "Invalid Baseten provider configuration");
    let url: URL;
    try { url = new URL(this.endpoint); } catch { throw new ModelProviderError("CONFIG", "Invalid Baseten endpoint URL"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) throw new ModelProviderError("CONFIG", "Baseten endpoint must be a plain HTTPS URL");
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    const safeText = (value: unknown, fallback: string): string => typeof value === "string" && /^[a-zA-Z0-9._/-]{1,120}$/.test(value) && !value.includes(this.apiKey) ? value : fallback;
    const diagnostics = (values: Partial<ModelDiagnostics> = {}): ModelDiagnostics => ({
      httpStatus: values.httpStatus ?? null,
      finishReason: values.finishReason ?? null,
      contentPresent: values.contentPresent ?? false,
      contentLength: values.contentLength ?? 0,
      model: safeText(values.model, safeText(this.model, "[invalid]")),
      latencyMs: Math.round(performance.now() - started),
      inputTokens: values.inputTokens,
      outputTokens: values.outputTokens,
      reasoningTokens: values.reasoningTokens,
    });
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (request.signal.aborted) throw new ModelProviderError("TIMEOUT", "Investigation deadline exceeded", diagnostics());
      let httpStatus: number | null = null;
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
            messages: [{ role: "system", content: request.instructions }, { role: "user", content: request.input }],
            response_format: { type: "json_schema", json_schema: { name: request.name, schema: request.schema, strict: true } },
            max_tokens: request.maxOutputTokens,
            ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        httpStatus = response.status;
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) { await backoff(attempt, request.signal); continue; }
          throw new ModelProviderError("HTTP", `Baseten API returned HTTP ${response.status}`, diagnostics({ httpStatus: response.status }));
        }
        let parsed: unknown;
        try { parsed = await readJson(response); }
        catch (error) {
          if (error instanceof ModelProviderError) throw new ModelProviderError(error.code, error.message, diagnostics({ httpStatus: response.status }));
          throw error;
        }
        const payload = asObject(parsed);
        const usage = asObject(payload?.usage);
        const inputTokens = usage?.prompt_tokens;
        const outputTokens = usage?.completion_tokens;
        const reasoningTokens = asObject(usage?.completion_tokens_details)?.reasoning_tokens;
        const counts = {
          inputTokens: Number.isSafeInteger(inputTokens) && (inputTokens as number) >= 0 ? inputTokens as number : undefined,
          outputTokens: Number.isSafeInteger(outputTokens) && (outputTokens as number) >= 0 ? outputTokens as number : undefined,
          reasoningTokens: Number.isSafeInteger(reasoningTokens) && (reasoningTokens as number) >= 0 ? reasoningTokens as number : undefined,
        };
        const choices = payload?.choices;
        const first = Array.isArray(choices) ? asObject(choices[0]) : null;
        const content = asObject(first?.message)?.content;
        const finishReason = safeText(first?.finish_reason, "unknown");
        const detail = diagnostics({
          httpStatus: response.status,
          finishReason: first?.finish_reason === undefined || first?.finish_reason === null ? null : finishReason,
          contentPresent: typeof content === "string" && content.length > 0,
          contentLength: typeof content === "string" ? content.length : 0,
          model: typeof payload?.model === "string" ? payload.model : undefined,
          ...counts,
        });
        if (!first) throw new ModelProviderError("MALFORMED", "Baseten response has no completion choice", detail);
        if (first.finish_reason !== "stop") throw new ModelProviderError("INCOMPLETE", "Baseten response did not finish normally", detail);
        if (typeof content !== "string" || !content.length || content.length > 64_000) throw new ModelProviderError("MALFORMED", "Baseten response has no bounded text content", detail);
        let value: unknown;
        try { value = JSON.parse(content); } catch { throw new ModelProviderError("MALFORMED", "Baseten response content is not JSON", detail); }
        return {
          value,
          model: detail.model,
          latencyMs: performance.now() - started,
          usage: counts.inputTokens !== undefined && counts.outputTokens !== undefined ? { inputTokens: counts.inputTokens, outputTokens: counts.outputTokens } : undefined,
          diagnostics: detail,
        };
      } catch (error) {
        if (error instanceof ModelProviderError) throw error.diagnostics ? error : new ModelProviderError(error.code, error.message, diagnostics({ httpStatus }));
        if (controller.signal.aborted) throw new ModelProviderError("TIMEOUT", "Baseten request timed out", diagnostics({ httpStatus }));
        if (attempt < this.maxRetries) { await backoff(attempt, request.signal); continue; }
        throw new ModelProviderError("NETWORK", "Baseten request failed", diagnostics({ httpStatus }));
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
      }
    }
    throw new ModelProviderError("NETWORK", "Baseten retry limit exhausted", diagnostics());
  }
}
