import { timingSafeEqual } from "node:crypto";
import { ModelProviderError } from "../ai/model-provider";
import type { ModelProvider } from "../ai/model-provider";
import { parseEvidencePacket } from "./ai-evidence";
import { aiInstructions, aiInterpretationSchema, parseAiInterpretation } from "./ai-interpretation";
import { aiChatInstructions, aiChatSchema, parseChatAnswer, parseChatHistory } from "./ai-chat";
import { parseRepositoryEvidencePacket } from "./ai-repository-evidence";
import { parseRepositoryAnswer, RepositoryAnswerValidationError, repositoryChatInstructions, repositoryChatSchema } from "./ai-repository-chat";
import { QuotaExceeded, type SqliteQuotaStore, type QuotaLease } from "../github-ingestion/quota-store";

type Dependencies = { enabled: boolean; origin: string | undefined; accessKey?: string; maxOutputTokens?: string; createProvider: () => ModelProvider; privateAuthorized: (request: Request) => boolean; developmentAccess?: boolean; now?: () => number; quota?: () => SqliteQuotaStore; subject?: (request: Request) => string };
const json = (body: object, status: number) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
export function interpretationOutputTokens(configured?: string): number {
  const value = configured === undefined ? 3_000 : Number(configured);
  if (!Number.isSafeInteger(value) || value < 512 || value > 4_000) throw new ModelProviderError("CONFIG", "Invalid feature AI output token limit.");
  return value;
}
export function allowDevelopmentAi(nodeEnv: string | undefined, flag: string | undefined, origin: string | undefined): boolean {
  if (nodeEnv !== "development" || flag !== "1") return false;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin ?? "").hostname); } catch { return false; }
}

export function createAiInterpretationHandler(deps: Dependencies) {
  let active = false, lastStarted = 0;
  return async function handle(request: Request): Promise<Response> {
    if (!deps.enabled || !deps.origin || !deps.developmentAccess && (!deps.accessKey || deps.accessKey.length < 32)) return json({ error: "AI interpretation is unavailable on this deployment." }, 503);
    if (request.headers.get("origin") !== deps.origin || request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "Request origin is not allowed." }, 403);
    if (!deps.developmentAccess && !equal(request.headers.get("x-codearchaeologist-ai-access-key") ?? "", deps.accessKey ?? "")) return json({ error: "AI analysis access key is invalid." }, 401);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return json({ error: "A JSON request is required." }, 415);
    if (Number(request.headers.get("content-length")) > 20_000) return json({ error: "Request exceeds the 20 KB limit." }, 413);
    let raw = "";
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Request body is required." }, 400);
    const bodyDeadline = AbortSignal.timeout(2_000);
    try {
      while (true) {
        const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => bodyDeadline.addEventListener("abort", () => reject(new Error("deadline")), { once: true }))]);
        if (part.done) break;
        raw += new TextDecoder("utf-8", { fatal: true }).decode(part.value);
        if (raw.length > 20_000) return json({ error: "Request exceeds the 20 KB limit." }, 413);
      }
    } catch { void reader.cancel().catch(() => undefined); return json({ error: "Could not read bounded request." }, 400); }
    finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON request." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || ![2, 4].includes(Object.keys(body).length) || (body as { consent?: unknown }).consent !== true) return json({ error: "Explicit AI evidence-sharing consent is required." }, 400);
    const repositoryScope = (body as { packet?: { scope?: unknown } }).packet?.scope === "repository";
    let packet;
    try { packet = repositoryScope ? parseRepositoryEvidencePacket((body as { packet?: unknown }).packet) : parseEvidencePacket((body as { packet?: unknown }).packet); } catch { return json({ error: "Invalid bounded evidence packet." }, 400); }
    const chat = Object.keys(body).length === 4;
    if (repositoryScope && !chat) return json({ error: "Repository analysis requires a bounded question." }, 400);
    let question = "", history: ReturnType<typeof parseChatHistory> = [];
    if (chat) {
      try {
        const input = body as { question?: unknown; history?: unknown };
        if (typeof input.question !== "string" || input.question.length < 1 || input.question.length > 300 || /[\u0000-\u001f\u007f<>]/.test(input.question)) throw new Error("Invalid question.");
        question = input.question;
        history = parseChatHistory(input.history, packet);
      } catch { return json({ error: "Invalid bounded chat request." }, 400); }
    }
    if (packet.origin === "private-github" && !deps.privateAuthorized(request)) return json({ error: "Connect GitHub before analyzing a private repository." }, 401);
    const now = deps.now?.() ?? Date.now();
    let lease: QuotaLease | undefined;
    if (deps.quota) {
      try { lease = deps.quota().reserve({ scope: "ai_start", subject: deps.subject?.(request) ?? "development-local", limit: 6, windowMs: 3_600_000, slot: "global_ai", leaseMs: 35_000 }); }
      catch (error) { if (error instanceof QuotaExceeded) return new Response(JSON.stringify({ error: "AI quota exceeded. Retry later.", rule: error.rule, retryAfter: error.retryAfterSeconds }), { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Retry-After": String(error.retryAfterSeconds) } }); throw error; }
    } else { if (active || now - lastStarted < 10_000) return json({ error: "AI analysis is busy. Retry shortly." }, 429); active = true; lastStarted = now; }
    try {
      const provider = deps.createProvider();
      const response = await provider.complete({ name: repositoryScope ? "repository_chat_v1" : chat ? "feature_chat_v1" : "feature_interpretation_v1", instructions: repositoryScope ? repositoryChatInstructions : chat ? aiChatInstructions : aiInstructions, input: JSON.stringify(chat ? { packet, question, history } : packet), schema: repositoryScope ? repositoryChatSchema : chat ? aiChatSchema : aiInterpretationSchema, maxOutputTokens: interpretationOutputTokens(deps.maxOutputTokens), signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) });
      if ("scope" in packet) return json({ scope: "repository", snapshotId: packet.snapshotId, answer: parseRepositoryAnswer(response.value, packet) }, 200);
      if (chat) return json({ featureId: packet.featureId, snapshotId: packet.snapshotId, answer: parseChatAnswer(response.value, packet) }, 200);
      return json({ featureId: packet.featureId, snapshotId: packet.snapshotId, interpretation: parseAiInterpretation(response.value, packet) }, 200);
    } catch (cause) {
      if (cause instanceof QuotaExceeded) return new Response(JSON.stringify({ error: "AI provider budget exceeded. Retry later.", rule: cause.rule, retryAfter: cause.retryAfterSeconds }), { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Retry-After": String(cause.retryAfterSeconds) } });
      const category = cause instanceof ModelProviderError ? `provider_${cause.code.toLowerCase()}` : "invalid_interpretation";
      const upstreamStatus = cause instanceof ModelProviderError && cause.diagnostics?.httpStatus && cause.diagnostics.httpStatus >= 400 && cause.diagnostics.httpStatus <= 599 ? cause.diagnostics.httpStatus : undefined;
      const finishReason = cause instanceof ModelProviderError && ["stop", "length", "content_filter", "tool_calls"].includes(cause.diagnostics?.finishReason ?? "") ? cause.diagnostics?.finishReason : undefined;
      const outputTokens = cause instanceof ModelProviderError && Number.isSafeInteger(cause.diagnostics?.outputTokens) && (cause.diagnostics?.outputTokens ?? 0) >= 0 && (cause.diagnostics?.outputTokens ?? 0) <= 100_000 ? cause.diagnostics?.outputTokens : undefined;
      const reasoningTokens = cause instanceof ModelProviderError && Number.isSafeInteger(cause.diagnostics?.reasoningTokens) && (cause.diagnostics?.reasoningTokens ?? 0) >= 0 && (cause.diagnostics?.reasoningTokens ?? 0) <= 100_000 ? cause.diagnostics?.reasoningTokens : undefined;
      return json({ error: "AI interpretation could not complete. Check provider configuration or retry later.", diagnostic: { category, ...(cause instanceof RepositoryAnswerValidationError ? { validationCategory: cause.category, ...(cause.field ? { field: cause.field } : {}), ...(cause.rule ? { rule: cause.rule } : {}) } : {}), ...(upstreamStatus ? { upstreamStatus } : {}), ...(finishReason ? { finishReason } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(reasoningTokens !== undefined ? { reasoningTokens } : {}) } }, 503);
    }
    finally { active = false; if (deps.quota) deps.quota().release(lease); }
  };
}
