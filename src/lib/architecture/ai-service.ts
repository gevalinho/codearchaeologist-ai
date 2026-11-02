import { timingSafeEqual } from "node:crypto";
import { ModelProviderError } from "../ai/model-provider";
import type { ModelProvider } from "../ai/model-provider";
import { parseEvidencePacket } from "./ai-evidence";
import { aiInstructions, aiInterpretationSchema, parseAiInterpretation } from "./ai-interpretation";
import { aiChatInstructions, aiChatSchema, parseChatAnswer, parseChatHistory } from "./ai-chat";
import { parseRepositoryEvidencePacket } from "./ai-repository-evidence";
import { parseRepositoryAnswer, RepositoryAnswerValidationError, repositoryChatInstructions, repositoryChatSchema } from "./ai-repository-chat";
import { QuotaExceeded, type SqliteQuotaStore, type QuotaLease } from "../github-ingestion/quota-store";
import type { UserSession } from "../github-ingestion/session";
import type { EvidencePacket } from "./ai-evidence";
import type { RepositoryEvidencePacket } from "./ai-repository-evidence";
import {
  advisorCitations,
  createHealthAdvisorPacket,
  healthAdvisorInstructions,
  healthAdvisorSchema,
  parseHealthAdvisorResponse,
} from "./ai-health-advisor";
import type { EvidenceOrigin } from "./ai-evidence";
import type { Graph } from "../archaeology/scanner";
import { MAX_ARTIFACT_BYTES, parseGraph } from "./graph";

type Dependencies = { enabled: boolean; origin: string | undefined; accessKey?: string; maxOutputTokens?: string; createProvider: () => ModelProvider; privateAuthorized: (request: Request) => boolean; developmentAccess?: boolean; now?: () => number; quota?: () => SqliteQuotaStore; subject?: (request: Request) => string; authenticate?: (request: Request) => Promise<UserSession | null>; authorizeArtifact?: (packet: EvidencePacket | RepositoryEvidencePacket, jobId: unknown, user: UserSession) => Promise<boolean>; resolveGraph?: (jobId: unknown, origin: EvidenceOrigin, request: Request, user: UserSession | null) => Promise<Graph | null> };
const json = (body: object, status: number) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const evidenceOrigins = new Set<EvidenceOrigin>(["browser-local", "public-github", "private-github", "imported-graph"]);
const MAX_HEALTH_REQUEST_BYTES = MAX_ARTIFACT_BYTES + 2_048;
export function interpretationOutputTokens(configured?: string): number {
  const value = configured === undefined ? 3_000 : Number(configured);
  if (!Number.isSafeInteger(value) || value < 512 || value > 4_000) throw new ModelProviderError("CONFIG", "Invalid feature AI output token limit.");
  return value;
}
export function allowDevelopmentAi(nodeEnv: string | undefined, flag: string | undefined, origin: string | undefined): boolean {
  if (nodeEnv !== "development" || flag !== "1") return false;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin ?? "").hostname); } catch { return false; }
}
export function allowProductionAi(nodeEnv: string | undefined, enabled: string | undefined, productionFlag: string | undefined, origin: string | undefined, githubOrigin: string | undefined): boolean {
  if (nodeEnv !== "production" || enabled !== "1" || productionFlag !== "1" || !origin || origin !== githubOrigin) return false;
  try { const url = new URL(origin); return url.protocol === "https:" && url.origin === origin && !url.username && !url.password; } catch { return false; }
}

export function createAiInterpretationHandler(deps: Dependencies) {
  let active = false, lastStarted = 0;
  return async function handle(request: Request): Promise<Response> {
    let stage = "request_validation";
    try {
    if (!deps.enabled || !deps.origin || !deps.developmentAccess && !deps.authenticate && (!deps.accessKey || deps.accessKey.length < 32)) return json({ error: "AI interpretation is unavailable on this deployment." }, 503);
    if (request.headers.get("origin") !== deps.origin || request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "Request origin is not allowed." }, 403);
    let user: UserSession | null = null;
    if (deps.authenticate) { try { user = await deps.authenticate(request); } catch { user = null; } if (!user) return json({ error: "Connect GitHub again before using AI." }, 401); }
    else if (!deps.developmentAccess && !equal(request.headers.get("x-codearchaeologist-ai-access-key") ?? "", deps.accessKey ?? "")) return json({ error: "AI analysis access key is invalid." }, 401);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return json({ error: "A JSON request is required." }, 415);
    const healthRequestHeader = request.headers.get("x-architecture-health-advisor") === "1";
    const requestByteLimit = healthRequestHeader ? MAX_HEALTH_REQUEST_BYTES : 20_000;
    if (Number(request.headers.get("content-length")) > requestByteLimit) return json({ error: healthRequestHeader ? "Request exceeds the bounded AI request limit." : "Request exceeds the 20 KB limit." }, 413);
    let raw = "", rawBytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Request body is required." }, 400);
    const bodyDeadline = AbortSignal.timeout(2_000);
    const readPart = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      if (bodyDeadline.aborted) { reject(new Error("Request body read deadline exceeded.")); return; }
      const onAbort = () => {
        bodyDeadline.removeEventListener("abort", onAbort);
        reject(new Error("Request body read deadline exceeded."));
      };
      bodyDeadline.addEventListener("abort", onAbort, { once: true });
      reader.read().then(
        part => { bodyDeadline.removeEventListener("abort", onAbort); resolve(part); },
        error => { bodyDeadline.removeEventListener("abort", onAbort); reject(error); },
      );
    });
    try {
      while (true) {
        const part = await readPart();
        if (part.done) break;
        rawBytes += part.value.byteLength;
        if (rawBytes > requestByteLimit) {
          await reader.cancel().catch(() => undefined);
          return json({ error: healthRequestHeader ? "Request exceeds the bounded AI request limit." : "Request exceeds the 20 KB limit." }, 413);
        }
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } catch { await reader.cancel().catch(() => undefined); return json({ error: "Could not read bounded request." }, 400); }
    finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON request." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || (body as { consent?: unknown }).consent !== true) return json({ error: "Explicit AI evidence-sharing consent is required." }, 400);
    const keys = Object.keys(body).sort().join(",");
    const healthRequest = keys === "consent,graph,mode,origin" || keys === "artifactId,consent,graph,mode,origin";
    if (healthRequest && rawBytes > 20_000 && !healthRequestHeader) return json({ error: "Architecture Health requests require the bounded graph request header." }, 413);
    if (healthRequest) {
      if ((body as { mode?: unknown }).mode !== "architecture-health") return json({ error: "Invalid bounded AI request." }, 400);
      const input = body as { graph?: unknown; origin?: unknown; artifactId?: unknown };
      if (typeof input.origin !== "string" || !evidenceOrigins.has(input.origin as EvidenceOrigin)) return json({ error: "Invalid evidence origin." }, 400);
      const origin = input.origin as EvidenceOrigin;
      let graph: Graph;
      stage = "graph_validation";
      try { graph = parseGraph(JSON.stringify(input.graph)); }
      catch { return json({ error: "Invalid bounded architecture graph." }, 400); }
      const githubOrigin = origin === "private-github" || origin === "public-github";
      if (input.artifactId !== undefined && !githubOrigin) return json({ error: "Invalid evidence artifact reference." }, 400);
      if (graph.githubSource?.visibility === "private" && origin !== "private-github") return json({ error: "Invalid evidence provenance." }, 400);
      if (githubOrigin) {
        stage = "artifact_authorization";
        const canonical = deps.resolveGraph
          ? await deps.resolveGraph(input.artifactId, origin, request, user).catch(() => null)
          : null;
        if (!canonical || JSON.stringify(canonical) !== JSON.stringify(graph)) return json({ error: "Evidence artifact is unavailable." }, 404);
        graph = canonical;
      }

      let healthPacket;
      stage = "health_evidence_derivation";
      try { healthPacket = createHealthAdvisorPacket(graph); }
      catch { return json({ error: "Architecture health evidence exceeds its bounded request limit." }, 413); }
      if (healthPacket.coverage.analysisSkipped || healthPacket.findings.length === 0) {
        return json({
          scope: "architecture-health",
          snapshotId: healthPacket.snapshotId,
          advisor: {
            schemaVersion: "1.0.0",
            observations: [],
            recommendations: [],
            uncertainty: [healthPacket.coverage.analysisSkipped
              ? "Health analysis was skipped because the graph exceeds its bounded analysis limits."
              : "No components crossed the current diagnostic thresholds; this does not establish that the architecture is risk-free."],
          },
          citations: [],
        }, 200);
      }

      const now = deps.now?.() ?? Date.now();
      let lease: QuotaLease | undefined;
      stage = "quota_reservation";
      if (deps.quota) {
        try { lease = deps.quota().reserve({ scope: "ai_start", subject: user?.id ?? deps.subject?.(request) ?? "development-local", limit: 6, windowMs: 3_600_000, slot: "global_ai", leaseMs: 35_000 }); }
        catch (error) { if (error instanceof QuotaExceeded) return new Response(JSON.stringify({ error: "AI quota exceeded. Retry later.", rule: error.rule, retryAfter: error.retryAfterSeconds }), { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Retry-After": String(error.retryAfterSeconds) } }); throw error; }
      } else { if (active || now - lastStarted < 10_000) return json({ error: "AI analysis is busy. Retry shortly." }, 429); active = true; lastStarted = now; }
      try {
        stage = "provider_creation";
        const provider = deps.createProvider();
        stage = "provider_invocation";
        const response = await provider.complete({
          name: "architecture_health_advisor_v1",
          instructions: healthAdvisorInstructions,
          input: JSON.stringify(healthPacket),
          schema: healthAdvisorSchema,
          maxOutputTokens: interpretationOutputTokens(deps.maxOutputTokens),
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
        });
        stage = "response_validation";
        const advisor = parseHealthAdvisorResponse(response.value, healthPacket);
        return json({
          scope: "architecture-health",
          snapshotId: healthPacket.snapshotId,
          advisor,
          citations: advisorCitations(advisor, healthPacket),
        }, 200);
      } catch (cause) {
        if (cause instanceof QuotaExceeded) return new Response(JSON.stringify({ error: "AI provider budget exceeded. Retry later.", rule: cause.rule, retryAfter: cause.retryAfterSeconds }), { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Retry-After": String(cause.retryAfterSeconds) } });
        const category = cause instanceof ModelProviderError ? `provider_${cause.code.toLowerCase()}` : "invalid_interpretation";
        const upstreamStatus = cause instanceof ModelProviderError && cause.diagnostics?.httpStatus && cause.diagnostics.httpStatus >= 400 && cause.diagnostics.httpStatus <= 599 ? cause.diagnostics.httpStatus : undefined;
        const finishReason = cause instanceof ModelProviderError && ["stop", "length", "content_filter", "tool_calls"].includes(cause.diagnostics?.finishReason ?? "") ? cause.diagnostics?.finishReason : undefined;
        const outputTokens = cause instanceof ModelProviderError && Number.isSafeInteger(cause.diagnostics?.outputTokens) && (cause.diagnostics?.outputTokens ?? 0) >= 0 && (cause.diagnostics?.outputTokens ?? 0) <= 100_000 ? cause.diagnostics?.outputTokens : undefined;
        const reasoningTokens = cause instanceof ModelProviderError && Number.isSafeInteger(cause.diagnostics?.reasoningTokens) && (cause.diagnostics?.reasoningTokens ?? 0) >= 0 && (cause.diagnostics?.reasoningTokens ?? 0) <= 100_000 ? cause.diagnostics?.reasoningTokens : undefined;
        return json({ error: "AI interpretation could not complete. Check provider configuration or retry later.", diagnostic: { category, ...(upstreamStatus ? { upstreamStatus } : {}), ...(finishReason ? { finishReason } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(reasoningTokens !== undefined ? { reasoningTokens } : {}) } }, 503);
      } finally {
        active = false;
        if (deps.quota) {
          stage = "quota_release";
          deps.quota().release(lease);
        }
      }
    }
    if (rawBytes > 20_000) return json({ error: "Request exceeds the 20 KB limit." }, 413);
    const chat = keys === "consent,history,packet,question" || keys === "artifactId,consent,history,packet,question";
    if (!chat && keys !== "consent,packet" && keys !== "artifactId,consent,packet") return json({ error: "Invalid bounded AI request." }, 400);
    const repositoryScope = (body as { packet?: { scope?: unknown } }).packet?.scope === "repository";
    let packet;
    try { packet = repositoryScope ? parseRepositoryEvidencePacket((body as { packet?: unknown }).packet) : parseEvidencePacket((body as { packet?: unknown }).packet); } catch { return json({ error: "Invalid bounded evidence packet." }, 400); }
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
    const artifactId = (body as { artifactId?: unknown }).artifactId;
    if (deps.authorizeArtifact && (packet.origin === "private-github" || packet.origin === "public-github")) {
      if (!user || !await deps.authorizeArtifact(packet, artifactId, user).catch(() => false)) return json({ error: "Evidence artifact is unavailable." }, 404);
    } else if (packet.origin === "private-github" && !deps.privateAuthorized(request)) return json({ error: "Connect GitHub before analyzing a private repository." }, 401);
    if (artifactId !== undefined && packet.origin !== "private-github" && packet.origin !== "public-github") return json({ error: "Invalid evidence artifact reference." }, 400);
    const now = deps.now?.() ?? Date.now();
    let lease: QuotaLease | undefined;
    if (deps.quota) {
      stage = "quota_reservation";
      try { lease = deps.quota().reserve({ scope: "ai_start", subject: user?.id ?? deps.subject?.(request) ?? "development-local", limit: 6, windowMs: 3_600_000, slot: "global_ai", leaseMs: 35_000 }); }
      catch (error) { if (error instanceof QuotaExceeded) return new Response(JSON.stringify({ error: "AI quota exceeded. Retry later.", rule: error.rule, retryAfter: error.retryAfterSeconds }), { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Retry-After": String(error.retryAfterSeconds) } }); throw error; }
    } else { if (active || now - lastStarted < 10_000) return json({ error: "AI analysis is busy. Retry shortly." }, 429); active = true; lastStarted = now; }
    try {
      stage = "provider_creation";
      const provider = deps.createProvider();
      stage = "provider_invocation";
      const response = await provider.complete({ name: repositoryScope ? "repository_chat_v1" : chat ? "feature_chat_v1" : "feature_interpretation_v1", instructions: repositoryScope ? repositoryChatInstructions : chat ? aiChatInstructions : aiInstructions, input: JSON.stringify(chat ? { packet, question, history } : packet), schema: repositoryScope ? repositoryChatSchema : chat ? aiChatSchema : aiInterpretationSchema, maxOutputTokens: interpretationOutputTokens(deps.maxOutputTokens), signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) });
      stage = "response_validation";
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
    finally {
      active = false;
      if (deps.quota) {
        stage = "quota_release";
        deps.quota().release(lease);
      }
    }
    } catch (cause) {
      if (process.env.NODE_ENV !== "production") {
        console.error(`[Feature AI] request failed at ${stage} (${cause instanceof Error ? cause.name : "unknown"})`);
      }
      return json({ error: "AI request could not be completed. Retry shortly.", diagnostic: { category: "request_failed" } }, 500);
    }
  };
}
