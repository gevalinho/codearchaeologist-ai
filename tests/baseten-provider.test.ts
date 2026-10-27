import { describe, expect, it, vi } from "vitest";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { BasetenModelProvider } from "../src/lib/ai/baseten-provider";
import { createLiveModelProvider } from "../src/lib/ai/provider-selection";
import { investigateFixture } from "../src/lib/agents/investigation-orchestrator";
import { buildOperatorArtifact, formatOperatorDiagnostic } from "../src/lib/demo/operator-workflow";

const request = { name: "selection", instructions: "Choose a file", input: '{"files":["pricing.js"]}', schema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"], additionalProperties: false }, maxOutputTokens: 100, signal: new AbortController().signal };
const payload = { model: "meta-models/muse-spark-open-1026", choices: [{ message: { content: '{"paths":["pricing.js"]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 14, completion_tokens: 6 } };

describe("Baseten provider HTTP boundary", () => {
  it("sends the documented endpoint, schema format, token cap, and system role", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const provider = new BasetenModelProvider({ apiKey: "secret-test-value", fetcher, maxRetries: 0 });
    const result = await provider.complete(request);
    expect(result).toMatchObject({ value: { paths: ["pricing.js"] }, model: "meta-models/muse-spark-open-1026", usage: { inputTokens: 14, outputTokens: 6 } });
    expect(result.diagnostics).toMatchObject({ httpStatus: 200, finishReason: "stop", contentPresent: true, contentLength: 24, model: "meta-models/muse-spark-open-1026", inputTokens: 14, outputTokens: 6 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetcher.mock.calls[0][0]).toBe("https://inference.baseten.co/v1/chat/completions");
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret-test-value" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "meta-models/muse-spark-open-1026", max_tokens: 100, response_format: { type: "json_schema", json_schema: { name: "selection", strict: true } } });
    expect(body.messages).toEqual([{ role: "system", content: request.instructions }, { role: "user", content: request.input }]);
    expect(body.max_completion_tokens).toBeUndefined();
  });
  it("accepts an explicit public model override without changing the hackathon default", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await new BasetenModelProvider({ apiKey: "test-key", model: "meta-models/muse-spark-open", fetcher }).complete(request);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).model).toBe("meta-models/muse-spark-open");
  });
  it("runs the fixture workflow through Baseten's HTTP shape without a paid call", async () => {
    const selections = [{ rules: [{ id: "loyalty", explanation: "Five-year customers receive a 15% discount", preconditions: [{ description: "customerYears >= 5" }], expectedBehavior: { description: "discountPercent is 15" }, confidence: 0.9, evidence: [{ path: "pricing.js", startLine: 5, endLine: 5 }] }] }, { assessments: [{ id: "loyalty", supported: true, reason: "Line 5 assigns 15" }] }];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...payload, choices: [{ message: { content: JSON.stringify(selections.shift()) }, finish_reason: "stop" }], usage: { ...payload.usage, completion_tokens_details: { reasoning_tokens: 3 } } }), { status: 200 }));
    const report = await investigateFixture({ fixtureId: "legacy-pricing", fixtureRoot: path.resolve("tests/fixtures/legacy-pricing"), provider: new BasetenModelProvider({ apiKey: "test-key", fetcher, maxRetries: 0 }) });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init?.body as string).max_tokens)).toEqual([3_000, 1_500]);
    expect(report.model).toMatchObject({ provider: "BASETEN", model: "meta-models/muse-spark-open-1026", calls: 2, inputTokens: 28, outputTokens: 12, reasoningTokens: 6 });
    expect(report.selection).toEqual({ method: "DETERMINISTIC_SINGLE_FILE", paths: ["pricing.js"] });
    expect(report.rules[0]).toMatchObject({ id: "loyalty", verificationStatus: "NOT_TESTED" });
    expect(report.rules[0].evidence[0].excerpt).toContain("discountPercent = 15");
  });
  it("rejects length even when JSON content is syntactically complete", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...payload, choices: [{ message: { content: "{}" }, finish_reason: "length" }], usage: { prompt_tokens: 14, completion_tokens: 256, completion_tokens_details: { reasoning_tokens: 245 } } }), { status: 200 }));
    await expect(new BasetenModelProvider({ apiKey: "test-key", fetcher, maxRetries: 0 }).complete(request)).rejects.toMatchObject({ code: "INCOMPLETE", diagnostics: { httpStatus: 200, finishReason: "length", contentPresent: true, contentLength: 2, outputTokens: 256, reasoningTokens: 245, model: payload.model } });
  });
  it("carries a length completion and bounded usage through the operator diagnostics", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...payload, choices: [{ message: { content: "{}" }, finish_reason: "length" }], usage: { completion_tokens: 1500, completion_tokens_details: { reasoning_tokens: 1400 } } }), { status: 200 }));
    const provider = new BasetenModelProvider({ apiKey: "secret-test-value", fetcher, maxRetries: 0 });
    const caught = await buildOperatorArtifact(provider, { run: vi.fn() }).catch((error: unknown) => error);
    const output = formatOperatorDiagnostic(caught, "CONFIGURATION");
    expect(output).toBe("Failure stage: INVESTIGATION\nInvestigation step: CANDIDATE_RULES\nError category: PROVIDER_INCOMPLETE\nHTTP status: 200\nFinish reason: length\nOutput tokens: 1500\nReasoning tokens: 1400\n");
    expect(output).not.toContain("secret-test-value");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("maps missing or malformed completion metadata to unknown and omits invalid counts", async () => {
    for (const response of [
      { choices: [{ message: { content: "{}" } }], usage: { completion_tokens: -1, completion_tokens_details: { reasoning_tokens: "999" } } },
      { choices: [{ message: { content: "{}" }, finish_reason: { untrusted: "raw secret" } }], usage: { completion_tokens: 1.5, completion_tokens_details: { reasoning_tokens: 1_000_001 } } },
      { choices: [{ message: { content: "{}" }, finish_reason: "untrusted_reason" }], usage: { completion_tokens: "1500", completion_tokens_details: { reasoning_tokens: -3 } } },
    ]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
      const provider = new BasetenModelProvider({ apiKey: "test-key", fetcher, maxRetries: 0 });
      const caught = await buildOperatorArtifact(provider, { run: vi.fn() }).catch((error: unknown) => error);
      const output = formatOperatorDiagnostic(caught, "CONFIGURATION");
      expect(output).toContain("Finish reason: unknown\n");
      expect(output).not.toContain("Output tokens:");
      expect(output).not.toContain("Reasoning tokens:");
      expect(output).not.toContain("raw secret");
    }
  });
  it("rejects missing finish reason, missing content, and unsupported reasons", async () => {
    const cases = [
      { choice: { message: { content: "{}" } }, reason: null, present: true, code: "INCOMPLETE" },
      { choice: { message: {}, finish_reason: "stop" }, reason: "stop", present: false, code: "MALFORMED" },
      { choice: { message: { content: "{}" }, finish_reason: "tool_calls" }, reason: "tool_calls", present: true, code: "INCOMPLETE" },
      { choice: { message: { content: "{}" }, finish_reason: "content_filter" }, reason: "content_filter", present: true, code: "INCOMPLETE" },
      { choice: { message: { content: "{}" }, finish_reason: "future_reason" }, reason: "future_reason", present: true, code: "INCOMPLETE" },
    ];
    for (const item of cases) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...payload, choices: [item.choice] }), { status: 200 }));
      await expect(new BasetenModelProvider({ apiKey: "test-key", fetcher, maxRetries: 0 }).complete(request)).rejects.toMatchObject({ code: item.code, diagnostics: { httpStatus: 200, finishReason: item.reason, contentPresent: item.present } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects missing choices and malformed JSON without printing content", async () => {
    for (const body of ["not json", JSON.stringify({ choices: [] })]) {
      const fetcher = vi.fn(async () => new Response(body, { status: 200 }));
      await expect(new BasetenModelProvider({ apiKey: "test-key", fetcher, maxRetries: 0 }).complete(request)).rejects.toMatchObject({ code: "MALFORMED", diagnostics: { httpStatus: 200, contentPresent: false, contentLength: 0 } });
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...payload, choices: [{ message: { content: "{broken" }, finish_reason: "stop" }] }), { status: 200 }));
    await expect(new BasetenModelProvider({ apiKey: "test-key", fetcher, maxRetries: 0 }).complete(request)).rejects.toMatchObject({ code: "MALFORMED", diagnostics: { httpStatus: 200, finishReason: "stop", contentPresent: true, contentLength: 7 } });
  });
  it("sanitizes HTTP errors and does not retry authorization failures", async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"secret-test-value"}', { status: 401 }));
    const provider = new BasetenModelProvider({ apiKey: "secret-test-value", fetcher, maxRetries: 2 });
    await expect(provider.complete(request)).rejects.toMatchObject({ code: "HTTP", message: "Baseten API returned HTTP 401" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retries rate limits at most once when configured", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    await new BasetenModelProvider({ apiKey: "test-key", fetcher, maxRetries: 1 }).complete(request);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("sends low reasoning effort only when configured", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await new BasetenModelProvider({ apiKey: "test-key", fetcher, reasoningEffort: "low", maxRetries: 0 }).complete(request);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).reasoning_effort).toBe("low");
  });
  it("times out stalled HTTP calls", async () => {
    const fetcher = vi.fn<typeof fetch>(async (...args) => new Promise<Response>((...settlers) => {
      args[1]?.signal?.addEventListener("abort", () => settlers[1](new DOMException("Aborted", "AbortError")), { once: true });
    }));
    await expect(new BasetenModelProvider({ apiKey: "test-key", fetcher, timeoutMs: 10, maxRetries: 0 }).complete(request)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("rejects invalid configuration and requires explicit live provider selection", () => {
    expect(() => new BasetenModelProvider({ apiKey: "" })).toThrow();
    expect(() => new BasetenModelProvider({ apiKey: "test-key", endpoint: "http://example.com" })).toThrow();
    expect(() => new BasetenModelProvider({ apiKey: "test-key", maxRetries: 10 })).toThrow();
    expect(() => createLiveModelProvider("mock")).toThrow();
    vi.stubEnv("BASETEN_API_KEY", "");
    expect(() => createLiveModelProvider("baseten")).toThrow();
    vi.unstubAllEnvs();
  });
});
