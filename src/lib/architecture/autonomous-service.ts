import type { ModelProvider } from "../ai/model-provider";
import { ModelProviderError } from "../ai/model-provider";
import { MAX_ARTIFACT_BYTES, parseGraph } from "./graph";
import { InvestigationValidationError, runAutonomousInvestigation, type InvestigationEvent } from "./autonomous-investigation";
import type { EvidenceOrigin } from "./ai-evidence";
import { RepositoryAnswerValidationError } from "./ai-repository-chat";

type Dependencies = { enabled: boolean; origin: string | undefined; createProvider: () => ModelProvider; privateAuthorized: (request: Request) => boolean; now?: () => number };
const MAX_REQUEST_BYTES = MAX_ARTIFACT_BYTES + 2_048;
const json = (body: object, status: number) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const origins = new Set<EvidenceOrigin>(["browser-local", "public-github", "private-github", "imported-graph"]);
async function readBounded(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("missing_body");
  const chunks: Uint8Array[] = []; let total = 0;
  const deadline = AbortSignal.timeout(5_000);
  const deadlinePromise = new Promise<never>((_, reject) => deadline.addEventListener("abort", () => reject(new Error("body_deadline")), { once: true }));
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadlinePromise]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) throw new Error("too_large");
      chunks.push(value);
    }
  } catch (cause) { await reader.cancel().catch(() => undefined); throw cause; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function createAutonomousInvestigationHandler(deps: Dependencies) {
  let active = false, lastStarted = 0;
  return async (request: Request): Promise<Response> => {
    if (!deps.enabled || !deps.origin) return json({ error: "Autonomous investigation is unavailable on this deployment." }, 503);
    if (request.headers.get("origin") !== deps.origin || request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "Request origin is not allowed." }, 403);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return json({ error: "A JSON request is required." }, 415);
    if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) return json({ error: "Graph artifact exceeds the request limit." }, 413);
    let input: unknown;
    try { input = JSON.parse(await readBounded(request)); }
    catch { return json({ error: "Invalid or oversized bounded investigation request." }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== "consent,goal,graph,origin" || (input as { consent?: unknown }).consent !== true) return json({ error: "Explicit investigation metadata consent is required." }, 400);
    const body = input as { goal?: unknown; graph?: unknown; origin?: unknown };
    if (typeof body.goal !== "string" || !body.goal.trim() || body.goal.length > 300 || /[\u0000-\u001f\u007f<>]/.test(body.goal) || !origins.has(body.origin as EvidenceOrigin)) return json({ error: "Invalid investigation goal or origin." }, 400);
    let graph;
    try { graph = parseGraph(JSON.stringify(body.graph)); } catch { return json({ error: "Invalid bounded graph artifact." }, 400); }
    if (body.origin === "private-github" && !deps.privateAuthorized(request)) return json({ error: "Connect GitHub before investigating a private repository." }, 401);
    const now = deps.now?.() ?? Date.now();
    if (active || now - lastStarted < 10_000) return json({ error: "AI investigation is busy. Retry shortly." }, 429);
    active = true; lastStarted = now;
    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(45_000)]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: InvestigationEvent | { type: "error"; category: string; rule?: string; field?: string }) => { if (!signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); };
        void (async () => {
          try { await runAutonomousInvestigation(graph, body.origin as EvidenceOrigin, body.goal as string, deps.createProvider(), signal, emit); }
          catch (cause) { emit(cause instanceof ModelProviderError ? { type: "error", category: `provider_${cause.code.toLowerCase()}` } : cause instanceof RepositoryAnswerValidationError ? { type: "error", category: "final_validation", rule: cause.category, ...(cause.field ? { field: cause.field } : {}) } : cause instanceof InvestigationValidationError ? { type: "error", category: "final_validation", rule: cause.category } : { type: "error", category: signal.aborted ? "cancelled_or_deadline" : "invalid_investigation" }); }
          finally { active = false; try { controller.close(); } catch { /* The client cancelled the stream. */ } }
        })();
      },
      cancel() { abort.abort(); },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  };
}
