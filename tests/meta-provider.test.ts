import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { MetaModelProvider } from "../src/lib/ai/meta-provider";

const request = { name: "example", instructions: "Return a JSON object", input: "source", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, maxOutputTokens: 100, signal: new AbortController().signal };
const payload = { model: "muse-spark-1.3", choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5 } };

describe("Meta provider HTTP boundary", () => {
  it("uses the documented request contract and validates response shape", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const provider = new MetaModelProvider({ apiKey: "test-key", fetcher, maxRetries: 0 });
    const response = await provider.complete(request);
    expect(response).toMatchObject({ value: { ok: true }, model: "muse-spark-1.3", usage: { inputTokens: 12, outputTokens: 5 } });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.meta.ai/v1/chat/completions");
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "muse-spark-1.3", response_format: { type: "json_schema" }, max_completion_tokens: 100 });
  });
  it("retries rate limits within a fixed bound", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    await new MetaModelProvider({ apiKey: "test-key", fetcher, maxRetries: 1 }).complete(request);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not retry malformed output or authentication failures", async () => {
    const malformed = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(new MetaModelProvider({ apiKey: "test-key", fetcher: malformed, maxRetries: 2 }).complete(request)).rejects.toMatchObject({ code: "MALFORMED" });
    expect(malformed).toHaveBeenCalledTimes(1);
    const denied = vi.fn(async () => new Response("", { status: 401 }));
    await expect(new MetaModelProvider({ apiKey: "test-key", fetcher: denied, maxRetries: 2 }).complete(request)).rejects.toMatchObject({ code: "HTTP" });
    expect(denied).toHaveBeenCalledTimes(1);
    const invalidJson = vi.fn(async () => new Response("not json", { status: 200 }));
    await expect(new MetaModelProvider({ apiKey: "test-key", fetcher: invalidJson, maxRetries: 2 }).complete(request)).rejects.toMatchObject({ code: "MALFORMED" });
    expect(invalidJson).toHaveBeenCalledTimes(1);
  });
  it("times out a stalled request", async () => {
    const fetcher = vi.fn<typeof fetch>(async (...args) => new Promise<Response>((...settlers) => {
      args[1]?.signal?.addEventListener("abort", () => settlers[1](new DOMException("Aborted", "AbortError")), { once: true });
    }));
    await expect(new MetaModelProvider({ apiKey: "test-key", fetcher, timeoutMs: 10, maxRetries: 0 }).complete(request)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("rejects missing credentials and non-HTTPS endpoints", () => {
    expect(() => new MetaModelProvider({ apiKey: "" })).toThrow();
    expect(() => new MetaModelProvider({ apiKey: "test-key", endpoint: "http://localhost:8080" })).toThrow();
  });
});
