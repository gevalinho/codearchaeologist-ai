import type { InvestigationReport } from "../../types/investigation";
import type { ModelProvider } from "../ai/model-provider";

type Dependencies = {
  enabled: boolean;
  createProvider: () => ModelProvider;
  investigate: (provider: ModelProvider) => Promise<InvestigationReport>;
};

let active = false;
let lastStarted = 0;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleInvestigationRequest(request: Request, dependencies: Dependencies): Promise<Response> {
  if (!dependencies.enabled) return json({ error: "Live investigation is disabled. Enable it for a trusted local demo." }, 403);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Cross-origin investigation is not allowed." }, 403);
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return json({ error: "Expected JSON request." }, 415);
  if (Number(request.headers.get("content-length")) > 128) return json({ error: "Request is too large." }, 413);
  let body = "";
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = request.body?.getReader();
    if (!reader) return json({ error: "Request body is required." }, 400);
    const stream = reader;
    body = await Promise.race([
      (async () => {
        let value = "";
        while (true) {
          const part = await stream.read();
          if (part.done) return value;
          value += new TextDecoder().decode(part.value);
          if (value.length > 128) throw new Error("oversized");
        }
      })(),
      new Promise<never>((_, reject) => { bodyTimer = setTimeout(() => reject(new Error("deadline")), 2_000); }),
    ]);
  } catch (error) {
    void reader?.cancel().catch(() => undefined);
    return json({ error: error instanceof Error && error.message === "oversized" ? "Request is too large." : "Could not read request within two seconds." }, error instanceof Error && error.message === "oversized" ? 413 : 400);
  } finally { clearTimeout(bodyTimer); }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return json({ error: "Invalid JSON request." }, 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || (parsed as { fixtureId?: unknown }).fixtureId !== "legacy-pricing") return json({ error: "Only the trusted legacy-pricing fixture is supported." }, 400);
  if (active || Date.now() - lastStarted < 60_000) return json({ error: "A live investigation is running or cooling down. Retry shortly." }, 429);
  active = true;
  lastStarted = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = dependencies.createProvider();
    const report = await Promise.race([
      dependencies.investigate(provider),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), 31_000); }),
    ]);
    return json({ report }, 200);
  } catch {
    return json({ error: "Investigation could not complete. Check server configuration and provider availability." }, 503);
  } finally {
    clearTimeout(timer);
    active = false;
  }
}
